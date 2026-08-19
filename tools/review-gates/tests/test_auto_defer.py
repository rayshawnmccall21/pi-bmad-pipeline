"""Auto-defer of advisory findings.

Under the scoped policy the advisory remainder still holds CodeRabbit's
approval hostage (it approves only when no actionable comments remain), so
reconcile closes them explicitly as accepted debt: a reply that says so, on
the thread, then resolve. It never claims the finding was fixed or wrong.

Opt-in only (--auto-defer-advisory); off by default so no existing pipeline
starts machine-resolving threads.
"""

import json
import stat
from pathlib import Path

from test_rulings import BOT, comment


def fixdir(tmp_path, monkeypatch):
    fix = tmp_path / "fix"
    fix.mkdir()
    fake = Path(__file__).parent / "fake_gh.py"
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("RG_GH", str(fake))
    monkeypatch.setenv("RG_FIXDIR", str(fix))
    return fix


def seed(out_dir, blocking, advisory):
    import _common as c

    c.write_json_atomic(out_dir / "queue.json", {
        "schema": "review-queue.v1", "generatedAt": "x",
        "ledgerRef": "ledger.json@sha256:abc", "headSha": "a" * 40,
        "blocking": blocking, "advisory": advisory,
        "nonBlocking": [], "excluded": [], "humanThreads": [],
        "meta": {"advertisedActionable": len(blocking) + len(advisory),
                 "reviewState": "CHANGES_REQUESTED",
                 "blockingPolicy": "scoped"},
    })
    c.write_json_atomic(out_dir / "ledger.json", {
        "schema": "review-ledger.v1", "generatedAt": "x", "storyId": "STY-91",
        "pr": {"repo": "o/r", "number": 561, "headSha": "a" * 40,
               "branch": "b", "state": "OPEN", "isDraft": False},
        "review": {"id": 1, "state": "CHANGES_REQUESTED",
                   "commitId": "a" * 40, "submittedAt": "x",
                   "matchesHead": True, "advertisedActionable": 1},
        "threads": [{"fingerprint": i["fingerprint"], "isResolved": False,
                     "isOutdated": False, "path": i.get("path"),
                     "line": i.get("line"), "author": "coderabbitai",
                     "excerpt": "x", "commentIds": [900 + n]}
                    for n, i in enumerate(blocking + advisory)],
        "outsideDiff": [], "counts": {"threads": len(blocking + advisory),
                                      "unresolved": 1, "outsideDiff": 0,
                                      "pages": 1},
    })
    return c.loop_state_init(out_dir, story_id="STY-91", pr=561, repo="o/r",
                             branch="b", head="a" * 40)


def item(fp, path, sev="medium", reason="below the blocking bar"):
    return {"fingerprint": fp, "rule": "R1-unresolved-thread", "kind": "thread",
            "severity": sev, "path": path, "line": 5, "excerpt": "finding",
            "advisoryReason": reason}


def test_advisory_deferred_only_when_opted_in(tmp_path, monkeypatch, out_dir):
    import reconcile_threads

    fixdir(tmp_path, monkeypatch)
    seed(out_dir, [item("PRRT_block", "apps/a.ts", "high")],
         [item("PRRT_adv", "qa/b.py")])
    import _common as c
    c.write_json_atomic(out_dir / "dispositions.json", {
        "schema": "dispositions.v1", "storyId": "STY-91", "dispositions": []})

    # default: advisory findings are reported, never machine-resolved
    assert reconcile_threads.main([
        "--out", str(out_dir), "--dry-run", "--allow-detached",
        "--evidence-dir", str(tmp_path)]) == 0
    plan = json.loads((out_dir / "reconcile-plan.json").read_text())
    assert not any(a["action"] == "auto_defer" for a in plan["actions"])

    assert reconcile_threads.main([
        "--out", str(out_dir), "--dry-run", "--allow-detached",
        "--auto-defer-advisory", "--evidence-dir", str(tmp_path)]) == 0
    plan = json.loads((out_dir / "reconcile-plan.json").read_text())
    deferred = [a for a in plan["actions"] if a["action"] == "auto_defer"]
    assert len(deferred) == 1
    assert deferred[0]["fingerprint"] == "PRRT_adv"
    assert deferred[0]["commentId"]                      # replies on-thread
    assert "debt" in deferred[0]["reply"].lower()
    assert "not been fixed" in deferred[0]["reply"].lower()
    assert plan["counts"]["autoDeferred"] == 1
    # a blocking finding is never auto-deferred
    assert all(a["fingerprint"] != "PRRT_block" for a in deferred)


def test_auto_defer_applies_reply_then_resolve(tmp_path, monkeypatch, out_dir):
    import reconcile_threads

    fix = fixdir(tmp_path, monkeypatch)
    seed(out_dir, [], [item("PRRT_adv", "qa/b.py")])
    import _common as c
    c.write_json_atomic(out_dir / "dispositions.json", {
        "schema": "dispositions.v1", "storyId": "STY-91", "dispositions": []})
    (fix / "node-threads.json").write_text(json.dumps({"PRRT_adv": {
        "comments": [comment("finding", author=BOT, association="NONE",
                             cid=900)]}}))

    assert reconcile_threads.main([
        "--out", str(out_dir), "--live", "--allow-detached",
        "--auto-defer-advisory", "--evidence-dir", str(tmp_path)]) == 0
    posted = [json.loads(l) for l in
              (fix / "posted-comments.jsonl").read_text().splitlines()]
    assert len(posted) == 1
    assert posted[0]["in_reply_to"] == "900"
    resolved = [json.loads(l) for l in
                (fix / "resolved.jsonl").read_text().splitlines()]
    assert [r["threadId"] for r in resolved] == ["PRRT_adv"]


def test_human_ruled_advisory_is_left_alone(tmp_path, monkeypatch, out_dir):
    """An advisory finding the owner already ruled keeps the human's
    disposition — auto-defer must not overwrite a ruling."""
    import reconcile_threads
    import _common as c

    fixdir(tmp_path, monkeypatch)
    seed(out_dir, [], [item("PRRT_adv", "qa/b.py")])
    c.write_json_atomic(out_dir / "dispositions.json", {
        "schema": "dispositions.v1", "storyId": "STY-91", "dispositions": [
            {"fingerprint": "PRRT_adv", "disposition": "false_positive",
             "evidence": {"rationale": "owner reviewed"},
             "ruledBy": {"login": "rayshawnmccall21", "id": 25748047,
                         "commentId": 1, "bodySha256": "ab" * 32}}]})
    assert reconcile_threads.main([
        "--out", str(out_dir), "--dry-run", "--allow-detached",
        "--auto-defer-advisory", "--evidence-dir", str(tmp_path)]) == 0
    plan = json.loads((out_dir / "reconcile-plan.json").read_text())
    by_fp = {a["fingerprint"]: a for a in plan["actions"]}
    assert by_fp["PRRT_adv"]["action"] == "reply_and_resolve"
    assert "Human ruling" in by_fp["PRRT_adv"]["reply"]


def test_advisory_findings_never_reach_the_approval_gate(tmp_path, monkeypatch,
                                                         out_dir):
    """Zero blocking + advisory present must not manufacture a regression."""
    import approval_gate

    fix = fixdir(tmp_path, monkeypatch)
    seed(out_dir, [], [item("PRRT_adv", "qa/b.py")])
    (fix / "pr.json").write_text(json.dumps({
        "head": {"sha": "a" * 40, "ref": "b"}, "state": "open",
        "draft": False, "mergeable_state": "clean"}))
    (fix / "view.json").write_text(json.dumps({
        "reviewDecision": "APPROVED", "statusCheckRollup": [],
        "mergeable": "MERGEABLE", "isDraft": False}))
    assert approval_gate.main([
        "--pr", "561", "--repo", "o/r", "--out", str(out_dir),
        "--mode", "final", "--allow-detached"]) == 0
