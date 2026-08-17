"""review_intake.py against the frozen PR #561 corpus (74 unresolved threads)."""

import json


def test_ledger_matches_fixture_reality(fixture_ledger):
    ledger = fixture_ledger
    assert ledger["schema"] == "review-ledger.v1"

    # Head identity: the review that gates approval targets the current head.
    assert ledger["pr"]["headSha"] == ledger["review"]["commitId"]
    assert ledger["review"]["matchesHead"] is True
    assert ledger["review"]["state"] == "CHANGES_REQUESTED"

    # The corpus: 77 threads, 74 unresolved, one GraphQL page.
    assert ledger["counts"]["threads"] == 77
    assert ledger["counts"]["unresolved"] == 74
    assert ledger["counts"]["pages"] == 1

    # Advertised actionable count parsed from the review body (drift detector).
    assert ledger["review"]["advertisedActionable"] == 2

    # Outside-diff: 1 advertised, 1 extracted, on docs/test-baseline.md.
    assert len(ledger["outsideDiff"]) == 1
    od = ledger["outsideDiff"][0]
    assert od["file"] == "docs/test-baseline.md"
    assert od["fingerprint"].startswith("od:")

    # Fingerprints are immutable thread IDs, never content hashes.
    assert all(t["fingerprint"].startswith("PRRT_") for t in ledger["threads"])


def test_intake_writes_loop_state_identity(fixture_ledger, out_dir):
    state = json.loads((out_dir / "loop-state.json").read_text())
    assert state["schema"] == "loop-state.v1"
    assert state["pr"] == 561
    assert state["expectedHead"] == fixture_ledger["pr"]["headSha"]
    assert state["reviewCycles"] == {"count": 0, "max": 3}
    assert state["chain"]["hash"]


def test_intake_escalates_on_head_drift(fake_gh, out_dir):
    """A pre-seeded loop-state with a different expectedHead is external
    interference: exit 2, never a regress, and no ledger is written."""
    import _common
    import review_intake

    out_dir.mkdir(parents=True)
    _common.loop_state_init(out_dir, story_id="STY-91", pr=561,
                            repo="rayshawnmccall21/StylePassV2",
                            branch="fix/STY-91-edit-plan-service-validation",
                            head="deadbeef" * 5)
    code = review_intake.main([
        "--pr", "561", "--repo", "rayshawnmccall21/StylePassV2",
        "--out", str(out_dir), "--story-id", "STY-91",
        "--max-polls", "1", "--allow-detached",
    ])
    assert code == 2
    assert not (out_dir / "ledger.json").exists()


def test_intake_adopts_head_moved_by_our_own_push(fake_gh, out_dir, monkeypatch):
    """update-pr pushed: PR head moved AND local HEAD matches it — adopt."""
    import json

    import _common
    import review_intake

    out_dir.mkdir(parents=True)
    _common.loop_state_init(out_dir, story_id="STY-91", pr=561,
                            repo="rayshawnmccall21/StylePassV2",
                            branch="whatever", head="0" * 40)
    fixture_head = json.loads(
        (out_dir / "loop-state.json").read_text())  # placeholder read
    import conftest

    live_head = json.loads(
        (conftest.FIXTURES / "pr.json").read_text())["head"]["sha"]
    monkeypatch.setattr(_common, "local_head", lambda: live_head)
    code = review_intake.main([
        "--pr", "561", "--repo", "rayshawnmccall21/StylePassV2",
        "--out", str(out_dir), "--story-id", "STY-91",
        "--max-polls", "1", "--allow-detached", "--no-request-review",
    ])
    assert code == 0
    state = json.loads((out_dir / "loop-state.json").read_text())
    assert state["expectedHead"] == live_head


def test_intake_escalates_when_moved_head_is_not_ours(fake_gh, out_dir, monkeypatch):
    import _common
    import review_intake

    out_dir.mkdir(parents=True)
    _common.loop_state_init(out_dir, story_id="STY-91", pr=561,
                            repo="rayshawnmccall21/StylePassV2",
                            branch="whatever", head="0" * 40)
    monkeypatch.setattr(_common, "local_head", lambda: "f" * 40)
    code = review_intake.main([
        "--pr", "561", "--repo", "rayshawnmccall21/StylePassV2",
        "--out", str(out_dir), "--story-id", "STY-91",
        "--max-polls", "1", "--allow-detached", "--no-request-review",
    ])
    assert code == 2
