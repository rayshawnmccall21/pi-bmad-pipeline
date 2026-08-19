"""reconcile_threads.py ruling extensions — defer, ruled false positives,
root-comment replies (§10 reply-then-resolve), and reply idempotence."""

import json
import shutil
import stat
from pathlib import Path

RULED_BY = {"login": "rayshawnmccall21", "id": 25748047,
            "commentId": 990001, "bodySha256": "ab" * 32,
            "ruledAt": "2026-08-18T10:00:00Z"}


def corpus_fixdir(tmp_path, monkeypatch):
    """A writable copy of the pr-561 corpus + a node-threads table derived
    from it, so live apply (writes + marker prechecks) can run."""
    src = Path(__file__).resolve().parents[1] / "fixtures" / "pr-561"
    fix = tmp_path / "fix"
    shutil.copytree(src, fix)
    fake = Path(__file__).parent / "fake_gh.py"
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("RG_GH", str(fake))
    monkeypatch.setenv("RG_FIXDIR", str(fix))

    data = json.loads((fix / "threads.json").read_text())
    table = {}
    for t in data["threads"]:
        table[t["id"]] = {
            "isResolved": t["isResolved"],
            "isOutdated": t["isOutdated"],
            "comments": [{
                "databaseId": cm["databaseId"], "isMinimized": False,
                "authorAssociation": "NONE", "body": cm["body"],
                "createdAt": "2026-08-01T00:00:00Z", "lastEditedAt": None,
                "author": {"login": cm["author"], "__typename": "Bot",
                           "databaseId": None},
            } for cm in t["comments"]],
        }
    (fix / "node-threads.json").write_text(json.dumps(table))
    return fix


def prep(out_dir):
    import review_intake
    import classify_findings

    assert review_intake.main([
        "--pr", "561", "--repo", "rayshawnmccall21/StylePassV2",
        "--out", str(out_dir), "--story-id", "STY-91",
        "--max-polls", "1", "--allow-detached",
    ]) == 0
    assert classify_findings.main(["--out", str(out_dir)]) == 0
    ledger = json.loads((out_dir / "ledger.json").read_text())
    queue = json.loads((out_dir / "queue.json").read_text())
    return ledger, queue


def seed(out_dir, dispositions):
    import _common

    _common.write_json_atomic(out_dir / "dispositions.json", {
        "checkpoint": "dev-story--review-dispositions", "status": "passed",
        "schema": "dispositions.v1", "storyId": "STY-91",
        "dispositions": dispositions,
    })


def roots_of(ledger):
    return {t["fingerprint"]: t["commentIds"][0] for t in ledger["threads"]
            if t.get("commentIds")}


def test_ruled_defer_plans_reply_and_resolve_with_root_comment(
        tmp_path, monkeypatch, out_dir):
    import reconcile_threads

    corpus_fixdir(tmp_path, monkeypatch)
    ledger, queue = prep(out_dir)
    fp = queue["blocking"][0]["fingerprint"]
    seed(out_dir, [
        {"fingerprint": fp, "disposition": "defer",
         "evidence": {"rationale": "debt, tracked as STY-140"},
         "ruledBy": dict(RULED_BY)},
    ])
    assert reconcile_threads.main([
        "--out", str(out_dir), "--dry-run",
        "--evidence-dir", str(tmp_path), "--allow-detached",
    ]) == 0
    plan = json.loads((out_dir / "reconcile-plan.json").read_text())
    action = next(a for a in plan["actions"] if a["fingerprint"] == fp)
    assert action["action"] == "reply_and_resolve"
    assert action["commentId"] == roots_of(ledger)[fp]
    assert "STY-140" in action["reply"]
    assert "Human ruling" in action["reply"]


def test_machine_defer_is_demoted_to_needs_human(tmp_path, monkeypatch, out_dir):
    import reconcile_threads

    corpus_fixdir(tmp_path, monkeypatch)
    _, queue = prep(out_dir)
    fp = queue["blocking"][0]["fingerprint"]
    seed(out_dir, [
        {"fingerprint": fp, "disposition": "defer",
         "evidence": {"rationale": "the model tries to shelve its homework"}},
    ])
    assert reconcile_threads.main([
        "--out", str(out_dir), "--dry-run",
        "--evidence-dir", str(tmp_path), "--allow-detached",
    ]) == 0
    plan = json.loads((out_dir / "reconcile-plan.json").read_text())
    action = next(a for a in plan["actions"] if a["fingerprint"] == fp)
    assert action["action"] == "needs_human"


def test_ruled_false_positive_resolves_machine_one_does_not(
        tmp_path, monkeypatch, out_dir):
    import reconcile_threads

    corpus_fixdir(tmp_path, monkeypatch)
    _, queue = prep(out_dir)
    ruled, machine = (queue["blocking"][0]["fingerprint"],
                      queue["blocking"][1]["fingerprint"])
    seed(out_dir, [
        {"fingerprint": ruled, "disposition": "false_positive",
         "evidence": {"rationale": "owner reviewed; fixture is torn down"},
         "ruledBy": dict(RULED_BY)},
        {"fingerprint": machine, "disposition": "false_positive",
         "evidence": {"rationale": "model belief"}},
    ])
    assert reconcile_threads.main([
        "--out", str(out_dir), "--dry-run",
        "--evidence-dir", str(tmp_path), "--allow-detached",
    ]) == 0
    plan = json.loads((out_dir / "reconcile-plan.json").read_text())
    by_fp = {a["fingerprint"]: a for a in plan["actions"]}
    assert by_fp[ruled]["action"] == "reply_and_resolve"
    assert "Human ruling" in by_fp[ruled]["reply"]
    assert by_fp[machine]["action"] == "reply_without_resolve"


def test_live_apply_posts_reply_then_resolves_and_is_idempotent(
        tmp_path, monkeypatch, out_dir):
    import _common as c
    import reconcile_threads

    fix = corpus_fixdir(tmp_path, monkeypatch)
    ledger, queue = prep(out_dir)
    head = ledger["pr"]["headSha"]
    fp = queue["blocking"][0]["fingerprint"]
    root = roots_of(ledger)[fp]
    seed(out_dir, [
        {"fingerprint": fp, "disposition": "defer",
         "evidence": {"rationale": "debt, tracked as STY-140"},
         "ruledBy": dict(RULED_BY)},
    ])

    assert reconcile_threads.main([
        "--out", str(out_dir), "--live",
        "--evidence-dir", str(tmp_path), "--allow-detached",
    ]) == 0
    posted = [json.loads(l) for l in
              (fix / "posted-comments.jsonl").read_text().splitlines()]
    assert len(posted) == 1
    assert posted[0]["in_reply_to"] == str(root)
    plan = json.loads((out_dir / "reconcile-plan.json").read_text())
    reply = next(a for a in plan["actions"]
                 if a["fingerprint"] == fp)["reply"]
    assert c.reply_marker(fp, head, reply) in posted[0]["body"]
    resolved = [json.loads(l) for l in
                (fix / "resolved.jsonl").read_text().splitlines()]
    assert resolved[0]["threadId"] == fp

    # a retry with the reply already on the thread must not repost it
    table = json.loads((fix / "node-threads.json").read_text())
    table[fp]["comments"].append({
        "databaseId": 990500, "isMinimized": False,
        "authorAssociation": "OWNER",
        "body": posted[0]["body"], "createdAt": "2026-08-18T10:00:00Z",
        "lastEditedAt": None,
        "author": {"login": "rayshawnmccall21", "__typename": "User",
                   "databaseId": 25748047},
    })
    (fix / "node-threads.json").write_text(json.dumps(table))
    assert reconcile_threads.main([
        "--out", str(out_dir), "--live",
        "--evidence-dir", str(tmp_path), "--allow-detached",
    ]) == 0
    posted = [json.loads(l) for l in
              (fix / "posted-comments.jsonl").read_text().splitlines()]
    assert len(posted) == 1                      # still exactly one reply
    resolved = [json.loads(l) for l in
                (fix / "resolved.jsonl").read_text().splitlines()]
    assert len(resolved) == 2                    # resolve re-verified both runs
