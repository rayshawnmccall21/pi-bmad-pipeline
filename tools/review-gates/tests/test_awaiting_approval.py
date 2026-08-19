"""Zero blocking findings + no reviewer approval is NOT a dev-story problem.

Two defects this covers, both observed live on PR #561 (2026-08-18):

1. The final gate returned exit 1 from the conjunction branch WITHOUT
   writing a findings file, so the runner lifted a stale findings.json from
   an earlier cycle and sent dev-story to re-fix three already-fixed
   defects — writing new code, which generates new findings. The gate must
   never leave a stale findings file behind: every final evaluation owns it.

2. Routing that state to dev-story is wrong on its face. With zero blocking
   findings there is no code work to do; the loop is waiting on the
   reviewer. It polls briefly, then escalates rather than manufacturing a
   regression.
"""

import json
import stat
from pathlib import Path


def fixdir(tmp_path, monkeypatch, *, review_decision, checks=None):
    fix = tmp_path / "fix"
    fix.mkdir()
    fake = Path(__file__).parent / "fake_gh.py"
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("RG_GH", str(fake))
    monkeypatch.setenv("RG_FIXDIR", str(fix))
    (fix / "pr.json").write_text(json.dumps({
        "head": {"sha": "a" * 40, "ref": "b"}, "state": "open",
        "draft": False, "mergeable_state": "clean"}))
    (fix / "view.json").write_text(json.dumps({
        "reviewDecision": review_decision,
        "statusCheckRollup": checks or [],
        "mergeable": "MERGEABLE", "isDraft": False}))
    return fix


def seed_clean_queue(out_dir, advisory=1):
    """Zero blocking, some advisory — the state after a successful cycle."""
    import _common as c

    c.write_json_atomic(out_dir / "queue.json", {
        "schema": "review-queue.v1", "generatedAt": "x",
        "ledgerRef": "ledger.json@sha256:abc", "headSha": "a" * 40,
        "blocking": [],
        "advisory": [{"fingerprint": f"PRRT_adv{n}", "rule": "R1",
                      "kind": "thread", "severity": "medium",
                      "path": "qa/x.py", "line": 1, "excerpt": "nit",
                      "advisoryReason": "medium severity below the bar"}
                     for n in range(advisory)],
        "nonBlocking": [], "excluded": [], "humanThreads": [],
        "meta": {"advertisedActionable": 0, "reviewState": "COMMENTED",
                 "blockingPolicy": "scoped"},
    })
    return c.loop_state_init(out_dir, story_id="STY-91", pr=561, repo="o/r",
                             branch="b", head="a" * 40)


def stale_findings(out_dir):
    import _common as c

    c.write_findings_file(out_dir / "findings.json", [
        {"fingerprint": "PRRT_old", "severity": "high", "file": "old.ts",
         "line": 1, "text": "a defect fixed three cycles ago"}])


def run_gate(out_dir, extra=None):
    import approval_gate

    return approval_gate.main([
        "--pr", "561", "--repo", "o/r", "--out", str(out_dir),
        "--mode", "final", "--allow-detached", *(extra or [])])


def test_stale_findings_never_survive_a_final_evaluation(tmp_path, monkeypatch,
                                                         out_dir):
    fixdir(tmp_path, monkeypatch, review_decision="REVIEW_REQUIRED")
    seed_clean_queue(out_dir)
    stale_findings(out_dir)

    code = run_gate(out_dir, ["--approval-poll-attempts", "1"])
    assert code == 2                    # not a regression: no code work exists
    # The stale file is removed outright, so the runner has nothing to lift.
    path = out_dir / "findings.json"
    if path.exists():
        texts = " ".join(f["text"] for f in
                         json.loads(path.read_text())["findings"])
        assert "fixed three cycles ago" not in texts


def test_awaiting_approval_escalates_rather_than_regressing(tmp_path,
                                                            monkeypatch,
                                                            out_dir, capsys):
    fixdir(tmp_path, monkeypatch, review_decision="REVIEW_REQUIRED")
    seed_clean_queue(out_dir)

    assert run_gate(out_dir, ["--approval-poll-attempts", "1"]) == 2
    err = capsys.readouterr().err
    assert "0 blocking" in err
    assert "not approved" in err                 # names the actual blocker
    assert "no code work left" in err            # and rules out a regression
    assert "REVIEW_REQUIRED" in err              # quotes the live decision


def test_approval_arriving_during_the_poll_passes_the_gate(tmp_path,
                                                           monkeypatch,
                                                           out_dir):
    fix = fixdir(tmp_path, monkeypatch, review_decision="APPROVED")
    seed_clean_queue(out_dir)
    stale_findings(out_dir)

    assert run_gate(out_dir, ["--approval-poll-attempts", "2"]) == 0
    assert not (out_dir / "findings.json").exists() or json.loads(
        (out_dir / "findings.json").read_text())["findings"] == []


def test_blocking_findings_still_regress_with_fresh_content(tmp_path,
                                                            monkeypatch,
                                                            out_dir):
    """The normal path must keep working — and rewrite findings each time."""
    import _common as c

    fixdir(tmp_path, monkeypatch, review_decision="REVIEW_REQUIRED")
    seed_clean_queue(out_dir)
    stale_findings(out_dir)
    q = json.loads((out_dir / "queue.json").read_text())
    q["blocking"] = [{"fingerprint": "PRRT_new", "rule": "R1",
                      "kind": "thread", "severity": "high",
                      "path": "apps/a.ts", "line": 9,
                      "excerpt": "a genuinely new defect"}]
    c.write_json_atomic(out_dir / "queue.json", q)

    assert run_gate(out_dir) == 1
    findings = json.loads((out_dir / "findings.json").read_text())
    texts = " ".join(f["text"] for f in findings["findings"])
    assert "genuinely new defect" in texts
    assert "fixed three cycles ago" not in texts


def test_failing_checks_are_not_a_dev_story_regression(tmp_path, monkeypatch,
                                                       out_dir):
    fixdir(tmp_path, monkeypatch, review_decision="APPROVED",
           checks=[{"conclusion": "FAILURE"}])
    seed_clean_queue(out_dir)
    assert run_gate(out_dir, ["--approval-poll-attempts", "1"]) == 3
