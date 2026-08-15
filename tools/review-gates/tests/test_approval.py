"""approval_gate.py — the conjunction, the budgets, the breakers."""

import json


def run_gate(out_dir, mode="final", extra=None):
    import approval_gate

    return approval_gate.main([
        "--pr", "561", "--repo", "rayshawnmccall21/StylePassV2",
        "--out", str(out_dir), "--mode", mode, "--allow-detached",
        *(extra or []),
    ])


def prep(out_dir):
    import classify_findings

    assert classify_findings.main(["--out", str(out_dir)]) == 0


def test_final_gate_exits_1_with_capped_findings(fixture_ledger, out_dir):
    prep(out_dir)
    code = run_gate(out_dir)
    assert code == 1  # blocking findings on a CHANGES_REQUESTED head

    findings = json.loads((out_dir / "findings.json").read_text())
    assert findings["schema"] == "stage-findings.v1"
    assert 0 < len(findings["findings"]) <= 50
    assert findings["findings"][0]["fingerprint"] == "meta:dispositions"
    assert "dispositions.json" in findings["findings"][0]["text"]
    total = sum(len(f["text"]) for f in findings["findings"])
    assert total <= 65536
    assert all(len(f["text"]) <= 2048 for f in findings["findings"])
    assert all("\x1b" not in f["text"] for f in findings["findings"])

    state = json.loads((out_dir / "loop-state.json").read_text())
    assert state["reviewCycles"]["count"] == 1


def test_fingerprint_survival_two_rounds_escalates(fixture_ledger, out_dir):
    prep(out_dir)
    assert run_gate(out_dir) == 1      # cycle 1: same findings recorded
    assert run_gate(out_dir) == 2      # cycle 2: survived twice -> escalate


def test_cycle_budget_exhaustion_escalates(fixture_ledger, out_dir):
    import _common

    prep(out_dir)
    state = _common.loop_state_load(out_dir)
    state["reviewCycles"]["count"] = 3
    _common.loop_state_save(out_dir, state)
    assert run_gate(out_dir) == 2


def test_retry_gate_passes_when_nothing_recoverable(fixture_ledger, out_dir):
    prep(out_dir)
    assert run_gate(out_dir, mode="retry") == 0


def test_retry_gate_regresses_on_pending_unapplied(fixture_ledger, out_dir):
    import _common

    prep(out_dir)
    state = _common.loop_state_load(out_dir)
    state["pendingUnapplied"] = ["PRRT_kwDOsomething"]
    _common.loop_state_save(out_dir, state)
    assert run_gate(out_dir, mode="retry") == 1
