"""classify_findings.py — pure rules over the ledger; no judgment, no network."""

import json

RULES = {"R1-unresolved-thread", "R2-outside-diff", "R3-new-on-head",
         "R4-resolved", "R5-outdated", "R6-summary-nitpick",
         "R7-command-ack", "R8-praise-info", "R9-unclassifiable"}


def run_classify(out_dir):
    import classify_findings

    code = classify_findings.main(["--out", str(out_dir)])
    assert code == 0
    return json.loads((out_dir / "queue.json").read_text())


def test_partition_is_complete_and_disjoint(fixture_ledger, out_dir):
    queue = run_classify(out_dir)
    ledger = fixture_ledger

    everything = queue["blocking"] + queue["nonBlocking"] + queue["excluded"]
    fingerprints = [i["fingerprint"] for i in everything]
    assert len(fingerprints) == len(set(fingerprints)), "fingerprint appears twice"
    assert len(everything) == ledger["counts"]["threads"] + len(ledger["outsideDiff"])
    assert all(i["rule"] in RULES for i in everything)


def test_rules_match_thread_state(fixture_ledger, out_dir):
    queue = run_classify(out_dir)
    ledger = fixture_ledger

    by_fp = {t["fingerprint"]: t for t in ledger["threads"]}
    expected_blocking = {
        fp for fp, t in by_fp.items()
        if not t["isResolved"] and not t["isOutdated"]
    } | {od["fingerprint"] for od in ledger["outsideDiff"]}

    got_blocking = {i["fingerprint"] for i in queue["blocking"]}
    assert got_blocking == expected_blocking

    resolved = {i["fingerprint"] for i in queue["nonBlocking"] if i["rule"] == "R4-resolved"}
    assert resolved == {fp for fp, t in by_fp.items() if t["isResolved"]}


def test_blocking_items_carry_severity_and_location(fixture_ledger, out_dir):
    queue = run_classify(out_dir)
    for item in queue["blocking"]:
        assert item["severity"] in {"critical", "high", "medium", "info"}
        if item["rule"] != "R2-outside-diff":
            assert item["path"], item
        assert item["excerpt"], "blocking item needs a capped excerpt"
        assert len(item["excerpt"]) <= 400
