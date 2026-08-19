"""approval_gate.py ruling extensions — escalation.json for every
ruling-eligible escalation, human-FP breaker exemption, findings enrichment."""

import json


def run_gate(out_dir, mode="final"):
    import approval_gate

    return approval_gate.main([
        "--pr", "561", "--repo", "rayshawnmccall21/StylePassV2",
        "--out", str(out_dir), "--mode", mode, "--allow-detached",
    ])


def prep(out_dir):
    import classify_findings

    assert classify_findings.main(["--out", str(out_dir)]) == 0
    return json.loads((out_dir / "queue.json").read_text())


def test_needs_human_escalation_writes_escalation_json(fixture_ledger, out_dir):
    import _common as c

    queue = prep(out_dir)
    fp = queue["blocking"][0]["fingerprint"]
    plan = {
        "schema": "reconcile-plan.v1", "generatedAt": "x", "dryRun": True,
        "queueRef": c.content_ref(out_dir / "queue.json"),
        "actions": [{"fingerprint": fp, "action": "needs_human",
                     "reason": "requires a product decision"}],
        "counts": {"needsHuman": 1, "uncovered": 0},
    }
    c.write_json_atomic(out_dir / "reconcile-plan.json", plan)

    assert run_gate(out_dir) == 2
    esc = json.loads((out_dir / "escalation.json").read_text())
    assert esc["schema"] == "escalation.v1"
    assert esc["kind"] == "needs_human"
    assert esc["headSha"] == queue["headSha"]
    assert len(esc["items"]) == 1
    item = esc["items"][0]
    assert item["fingerprint"] == fp
    assert item["reason"] == "requires a product decision"
    ledger = json.loads((out_dir / "ledger.json").read_text())
    roots = {t["fingerprint"]: t["commentIds"][0] for t in ledger["threads"]
             if t.get("commentIds")}
    assert item["rootCommentId"] == roots[fp]


def test_survival_breach_writes_escalation_json(fixture_ledger, out_dir):
    import _common as c

    queue = prep(out_dir)
    assert run_gate(out_dir) == 1                 # head H: survival -> 1
    state = c.loop_state_load(out_dir)
    state["lastSurvivalHead"] = "different-head"  # simulate the next cycle
    c.loop_state_save(out_dir, state)

    assert run_gate(out_dir) == 2                 # survived twice -> escalate
    esc = json.loads((out_dir / "escalation.json").read_text())
    assert esc["kind"] == "survival"
    assert esc["headSha"] == queue["headSha"]
    fps = {i["fingerprint"] for i in esc["items"]}
    assert fps == {i["fingerprint"] for i in queue["blocking"]}
    assert all("survived" in i["reason"] for i in esc["items"])
    assert all("rootCommentId" in i for i in esc["items"])


def test_non_escalating_run_clears_stale_escalation(fixture_ledger, out_dir):
    import _common as c

    prep(out_dir)
    c.write_json_atomic(out_dir / "escalation.json", {
        "schema": "escalation.v1", "kind": "needs_human",
        "generatedAt": "x", "headSha": "stale", "items": []})
    assert run_gate(out_dir) == 1                 # ordinary blocking regress
    assert not (out_dir / "escalation.json").exists()


def test_fp_breaker_ignores_human_ruled_false_positives(fixture_ledger, out_dir):
    import _common as c

    queue = prep(out_dir)
    ruled_by = {"login": "rayshawnmccall21", "id": 25748047,
                "commentId": 1, "bodySha256": "ab" * 32, "ruledAt": "x"}
    fps = [i["fingerprint"] for i in queue["blocking"]][:6]

    human = [{"fingerprint": fp, "disposition": "false_positive",
              "evidence": {"rationale": "owner ruled"},
              "ruledBy": dict(ruled_by)} for fp in fps]
    c.write_json_atomic(out_dir / "dispositions.json", {
        "schema": "dispositions.v1", "storyId": "STY-91",
        "dispositions": human})
    assert run_gate(out_dir) == 1                 # human FPs never trip it

    machine = [{"fingerprint": fp, "disposition": "false_positive",
                "evidence": {"rationale": "model belief"}} for fp in fps]
    c.write_json_atomic(out_dir / "dispositions.json", {
        "schema": "dispositions.v1", "storyId": "STY-91",
        "dispositions": machine})
    assert run_gate(out_dir) == 2                 # machine FPs still do


def test_findings_carry_human_fix_ruling(fixture_ledger, out_dir):
    import _common as c

    queue = prep(out_dir)
    fp = queue["blocking"][0]["fingerprint"]
    c.write_json_atomic(out_dir / "rulings.json", {
        "schema": "rulings.v1",
        "ruler": {"login": "rayshawnmccall21", "id": 25748047},
        "rulings": {fp: {"verb": "fix",
                         "reason": "extract the validator, one commit",
                         "commentId": 1, "ruledAt": "x"}},
    })
    assert run_gate(out_dir) == 1
    findings = json.loads((out_dir / "findings.json").read_text())
    enriched = next(f for f in findings["findings"] if f["fingerprint"] == fp)
    assert "HUMAN RULING (fix): extract the validator" in enriched["text"]
