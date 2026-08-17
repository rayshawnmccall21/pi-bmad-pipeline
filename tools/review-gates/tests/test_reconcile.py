"""reconcile_threads.py — a clerk that verifies before it acts, dry-run first."""

import json
import subprocess


def seed(out_dir, fixture_ledger, dispositions):
    import _common

    _common.write_json_atomic(out_dir / "dispositions.json", {
        "checkpoint": "dev-story--review-dispositions",
        "status": "passed",
        "schema": "dispositions.v1",
        "storyId": "STY-91",
        "queueRef": "queue.json",
        "dispositions": dispositions,
    })


def run_classify(out_dir):
    import classify_findings

    assert classify_findings.main(["--out", str(out_dir)]) == 0
    return json.loads((out_dir / "queue.json").read_text())


def test_dry_run_verifies_before_planning(fixture_ledger, out_dir, tmp_path):
    import reconcile_threads

    queue = run_classify(out_dir)
    real_commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], capture_output=True, text=True
    ).stdout.strip()

    evidence = tmp_path / "evidence"
    evidence.mkdir()
    (evidence / "results.txt").write_text("plan-edit-price.e2e ... passed\n")

    fps = [i["fingerprint"] for i in queue["blocking"]]
    seed(out_dir, fixture_ledger, [
        {"fingerprint": fps[0], "disposition": "fix",
         "evidence": {"commitSha": real_commit, "testId": "plan-edit-price.e2e"}},
        {"fingerprint": fps[1], "disposition": "fix",
         "evidence": {"commitSha": "0" * 40, "testId": "missing.e2e"}},
        {"fingerprint": fps[2], "disposition": "false_positive",
         "evidence": {"rationale": "guard exists two lines above"}},
        {"fingerprint": fps[3], "disposition": "needs_human",
         "evidence": {"rationale": "product decision"}},
    ])

    code = reconcile_threads.main([
        "--out", str(out_dir), "--dry-run",
        "--evidence-dir", str(evidence), "--allow-detached",
    ])
    assert code == 0
    plan = json.loads((out_dir / "reconcile-plan.json").read_text())

    by_fp = {a["fingerprint"]: a for a in plan["actions"]}
    assert by_fp[fps[0]]["action"] == "reply_and_resolve"       # verified fix
    assert by_fp[fps[1]]["action"] == "skip_unverified"          # bogus commit
    assert by_fp[fps[2]]["action"] == "reply_without_resolve"    # FP never resolves
    assert by_fp[fps[3]]["action"] == "needs_human"
    assert plan["counts"]["uncovered"] == len(queue["blocking"]) - 4


def test_missing_dispositions_cycle0_passes_through(fixture_ledger, out_dir, tmp_path):
    import json
    import reconcile_threads

    run_classify(out_dir)
    code = reconcile_threads.main([
        "--out", str(out_dir), "--dry-run",
        "--evidence-dir", str(tmp_path), "--allow-detached",
    ])
    assert code == 0  # cycle 0: dev-story never regressed, nothing owed yet
    plan = json.loads((out_dir / "reconcile-plan.json").read_text())
    assert plan["counts"]["needsHuman"] == 0
    assert plan["counts"]["uncovered"] > 0


def test_missing_dispositions_cycle1_escalates(fixture_ledger, out_dir, tmp_path):
    import _common
    import reconcile_threads

    run_classify(out_dir)
    state = _common.loop_state_load(out_dir)
    state["reviewCycles"]["count"] = 1
    _common.loop_state_save(out_dir, state)
    code = reconcile_threads.main([
        "--out", str(out_dir), "--dry-run",
        "--evidence-dir", str(tmp_path), "--allow-detached",
    ])
    assert code == 2  # dev-story ran and owed dispositions: fail closed
