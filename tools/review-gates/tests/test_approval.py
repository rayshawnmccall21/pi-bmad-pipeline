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


def test_fingerprint_survival_counts_per_head_not_per_evaluation(fixture_ledger, out_dir):
    import _common

    prep(out_dir)
    assert run_gate(out_dir) == 1      # head H eval 1: survival -> 1
    assert run_gate(out_dir) == 1      # head H eval 2: same head, NO extra bump
    state = _common.loop_state_load(out_dir)
    assert all(v["survived"] == 1 for v in state["fingerprints"].values())


def test_fingerprint_survival_two_heads_escalates(fixture_ledger, out_dir):
    import _common

    prep(out_dir)
    assert run_gate(out_dir) == 1      # head H: survival -> 1
    state = _common.loop_state_load(out_dir)
    state["lastSurvivalHead"] = "different-head"   # simulate a new review cycle
    _common.loop_state_save(out_dir, state)
    assert run_gate(out_dir) == 2      # second head: survived twice -> escalate


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


def test_needs_human_escalation_enumerates_and_outranks_budget(fixture_ledger, out_dir, capsys):
    import _common
    import json

    prep(out_dir)
    queue = json.loads((out_dir / "queue.json").read_text())
    fp = queue["blocking"][0]["fingerprint"]
    plan = {
        "schema": "reconcile-plan.v1", "generatedAt": "x", "dryRun": True,
        "queueRef": _common.content_ref(out_dir / "queue.json"),
        "actions": [{"fingerprint": fp, "action": "needs_human",
                     "reason": "requires a product decision on rollover"}],
        "counts": {"needsHuman": 1, "uncovered": 0},
    }
    _common.write_json_atomic(out_dir / "reconcile-plan.json", plan)
    state = _common.loop_state_load(out_dir)
    state["reviewCycles"]["count"] = 3   # budget exhausted too
    _common.loop_state_save(out_dir, state)

    assert run_gate(out_dir) == 2
    err = capsys.readouterr().err
    assert "needs_human" in err            # the human question wins,
    assert "budget" not in err             # budget does not mask it
    assert fp[:24] in err                  # items are enumerated
    assert "product decision on rollover" in err


def test_stale_reconcile_plan_is_ignored(fixture_ledger, out_dir, capsys):
    import _common

    prep(out_dir)
    plan = {
        "schema": "reconcile-plan.v1", "generatedAt": "x", "dryRun": True,
        "queueRef": "queue.json@sha256:000000000000",   # stale
        "actions": [{"fingerprint": "PRRT_x", "action": "needs_human",
                     "reason": "stale"}],
        "counts": {"needsHuman": 1, "uncovered": 0},
    }
    _common.write_json_atomic(out_dir / "reconcile-plan.json", plan)
    code = run_gate(out_dir)
    err = capsys.readouterr().err
    assert "stale" in err
    assert code == 1   # falls through to the blocking-findings branch
