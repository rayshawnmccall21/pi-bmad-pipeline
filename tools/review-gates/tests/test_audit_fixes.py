"""Fixes from the adversarial audit — every finding gets a regression test.

HIGH-1   machine outdated_fixed/duplicate must verify or stay blocking
HIGH-2   consumed rulings expire per escalation epoch (no vacuous relaunch)
MEDIUM-1 collect validates escalation head+story against loop-state
MEDIUM-2 reply markers carry a content digest (ruled reply never suppressed
         by a prior machine reply at the same head)
MEDIUM-3 od: fingerprints never reach nodes(ids:); dispositions-file edits
         satisfy non-thread items
LOW-3    an owner quote-reply containing the ask marker still rules
LOW-4    FP ratio denominator counts machine dispositions only
LOW-5    reply_and_resolve without a root comment fails closed
LOW-6    an Organization ruler pin is refused with a clear error
"""

import json
from pathlib import Path

from test_rulings import (BOT, comment, ruling_fixdir, seed_dispositions,
                          seed_escalation, seed_loop, thread_table)


# ------------------------------------------------------------------- HIGH-1

def _plan(out_dir, dispositions, evidence_dir, queue=None):
    import reconcile_threads

    queue = queue or {
        "blocking": [{"fingerprint": "PRRT_dup", "rule": "R1", "severity": "high",
                      "path": "a.ts", "line": 1, "excerpt": "x"},
                     {"fingerprint": "PRRT_od", "rule": "R1", "severity": "high",
                      "path": "b.ts", "line": 2, "excerpt": "y"},
                     {"fingerprint": "PRRT_fix", "rule": "R1", "severity": "high",
                      "path": "c.ts", "line": 3, "excerpt": "z"}],
        "nonBlocking": [{"fingerprint": "PRRT_resolved", "rule": "R4-resolved"}],
    }
    return reconcile_threads.plan_actions(queue, dispositions, evidence_dir)


def test_machine_outdated_fixed_requires_evidence(tmp_path):
    evidence = tmp_path / "ev"
    evidence.mkdir()
    actions = _plan(tmp_path / "o", [
        {"fingerprint": "PRRT_od", "disposition": "outdated_fixed",
         "evidence": {"rationale": "trust me"}}], evidence)
    assert actions[0]["action"] == "skip_unverified"

    (evidence / "run.txt").write_text("absence-check.e2e ... passed\n")
    actions = _plan(tmp_path / "o", [
        {"fingerprint": "PRRT_od", "disposition": "outdated_fixed",
         "evidence": {"rationale": "gone", "testId": "absence-check.e2e"}}],
        evidence)
    assert actions[0]["action"] == "reply_and_resolve"


def test_machine_duplicate_requires_covered_canonical(tmp_path):
    evidence = tmp_path / "ev"
    evidence.mkdir()
    # canonical is a bogus fingerprint -> stays blocking
    actions = _plan(tmp_path / "o", [
        {"fingerprint": "PRRT_dup", "disposition": "duplicate",
         "evidence": {"canonicalFingerprint": "PRRT_nowhere"}}], evidence)
    assert actions[0]["action"] == "skip_unverified"

    # canonical already non-blocking (resolved) -> verified
    actions = _plan(tmp_path / "o", [
        {"fingerprint": "PRRT_dup", "disposition": "duplicate",
         "evidence": {"canonicalFingerprint": "PRRT_resolved"}}], evidence)
    assert actions[0]["action"] == "reply_and_resolve"

    # canonical covered by a VERIFIED fix in the same batch -> verified
    (evidence / "run.txt").write_text("dup-canon.e2e ... passed\n")
    import subprocess
    sha = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True,
                         text=True).stdout.strip()
    actions = _plan(tmp_path / "o", [
        {"fingerprint": "PRRT_fix", "disposition": "fix",
         "evidence": {"commitSha": sha, "testId": "dup-canon.e2e"}},
        {"fingerprint": "PRRT_dup", "disposition": "duplicate",
         "evidence": {"canonicalFingerprint": "PRRT_fix"}}], evidence)
    by_fp = {a["fingerprint"]: a for a in actions}
    assert by_fp["PRRT_fix"]["action"] == "reply_and_resolve"
    assert by_fp["PRRT_dup"]["action"] == "reply_and_resolve"

    # ruled duplicate needs no coverage proof — the owner is the arbiter
    actions = _plan(tmp_path / "o", [
        {"fingerprint": "PRRT_dup", "disposition": "duplicate",
         "evidence": {"canonicalFingerprint": "PRRT_nowhere"},
         "ruledBy": {"login": "rayshawnmccall21", "id": 25748047,
                     "commentId": 1, "bodySha256": "ab" * 32}}], evidence)
    assert actions[0]["action"] == "reply_and_resolve"


# ------------------------------------------------------------------- HIGH-2

def test_reescalated_fingerprint_becomes_outstanding_again(
        tmp_path, monkeypatch):
    import collect_rulings

    fix = ruling_fixdir(tmp_path, monkeypatch)
    out_dir = tmp_path / "review-loop"
    seed_loop(out_dir)
    seed_escalation(out_dir, [
        {"fingerprint": "PRRT_a", "path": "a.ts", "line": 1,
         "reason": "r", "rootCommentId": 111}])
    seed_dispositions(out_dir, [
        {"fingerprint": "PRRT_a", "disposition": "needs_human",
         "evidence": {"rationale": "r"}}])
    thread_table(fix, {"PRRT_a": {"comments": [
        comment("finding", author=BOT, association="NONE", cid=111),
        comment("/rule fix — round one", cid=112,
                created="2026-08-18T10:00:00Z"),
    ]}})
    assert collect_rulings.main(["--out", str(out_dir)]) == 0

    # the gate re-escalates the same fingerprint in a NEWER epoch: the old
    # consumed ruling must NOT satisfy it, and the old comment must not be
    # re-accepted — only a newer ruling clears it
    seed_dispositions(out_dir, [
        {"fingerprint": "PRRT_a", "disposition": "needs_human",
         "evidence": {"rationale": "came back"}}])
    seed_escalation(out_dir, [
        {"fingerprint": "PRRT_a", "path": "a.ts", "line": 1,
         "reason": "came back", "rootCommentId": 111}])
    esc = json.loads((out_dir / "escalation.json").read_text())
    esc["generatedAt"] = "2027-01-01T00:00:00Z"
    import _common as c
    c.write_json_atomic(out_dir / "escalation.json", esc)

    assert collect_rulings.main(["--out", str(out_dir)]) == 1  # outstanding

    thread_table(fix, {"PRRT_a": {"comments": [
        comment("finding", author=BOT, association="NONE", cid=111),
        comment("/rule fix — round one", cid=112,
                created="2026-08-18T10:00:00Z"),
        comment("/rule defer — second ruling", cid=113,
                created="2027-01-02T00:00:00Z"),
    ]}})
    assert collect_rulings.main(["--out", str(out_dir)]) == 0
    disp = json.loads((out_dir / "dispositions.json").read_text())
    by_fp = {d["fingerprint"]: d for d in disp["dispositions"]}
    assert by_fp["PRRT_a"]["disposition"] == "defer"
    assert by_fp["PRRT_a"]["ruledBy"]["commentId"] == 113


# ----------------------------------------------------------------- MEDIUM-1

def test_collect_refuses_stale_or_foreign_escalation(tmp_path, monkeypatch):
    import collect_rulings
    import _common as c

    ruling_fixdir(tmp_path, monkeypatch)
    out_dir = tmp_path / "review-loop"
    seed_loop(out_dir)
    seed_escalation(out_dir, [
        {"fingerprint": "PRRT_a", "path": "a.ts", "line": 1,
         "reason": "r", "rootCommentId": 111}], head="0" * 40)  # wrong head
    assert collect_rulings.main(["--out", str(out_dir)]) == 2

    seed_escalation(out_dir, [
        {"fingerprint": "PRRT_a", "path": "a.ts", "line": 1,
         "reason": "r", "rootCommentId": 111}])
    esc = json.loads((out_dir / "escalation.json").read_text())
    esc["storyId"] = "STY-OTHER"
    c.write_json_atomic(out_dir / "escalation.json", esc)
    assert collect_rulings.main(["--out", str(out_dir)]) == 2


# ----------------------------------------------------------------- MEDIUM-3

def test_outside_diff_items_never_hit_graphql_and_are_hand_ruleable(
        tmp_path, monkeypatch):
    import collect_rulings

    fix = ruling_fixdir(tmp_path, monkeypatch)
    out_dir = tmp_path / "review-loop"
    seed_loop(out_dir)
    seed_escalation(out_dir, [
        {"fingerprint": "od:952c94411842a086f4e9", "path": "docs/x.md",
         "line": None, "reason": "outside diff", "rootCommentId": None},
        {"fingerprint": "PRRT_a", "path": "a.ts", "line": 1,
         "reason": "r", "rootCommentId": 111}])
    seed_dispositions(out_dir, [
        {"fingerprint": "od:952c94411842a086f4e9",
         "disposition": "needs_human", "evidence": {"rationale": "?"}},
        {"fingerprint": "PRRT_a", "disposition": "needs_human",
         "evidence": {"rationale": "r"}}])
    thread_table(fix, {"PRRT_a": {"comments": [
        comment("finding", author=BOT, association="NONE", cid=111),
        comment("/rule fix — go", cid=112),
    ]}})
    # od: item cannot be thread-ruled -> outstanding, PRRT collected fine
    assert collect_rulings.main(["--out", str(out_dir)]) == 1

    # hand-editing dispositions.json (the sanctioned surface) satisfies it
    disp = json.loads((out_dir / "dispositions.json").read_text())
    for d in disp["dispositions"]:
        if d["fingerprint"].startswith("od:"):
            d["disposition"] = "false_positive"
            d["evidence"] = {"rationale": "hand-ruled"}
    import _common as c
    c.write_json_atomic(out_dir / "dispositions.json", disp)
    assert collect_rulings.main(["--out", str(out_dir)]) == 0


# ----------------------------------------------------------------- MEDIUM-2

def test_reply_marker_distinguishes_content(tmp_path):
    import _common as c

    machine = c.reply_marker("PRRT_x", "head1", "We believe this is a false positive")
    ruled = c.reply_marker("PRRT_x", "head1", "Human ruling: false positive")
    assert machine != ruled
    assert c.reply_marker("PRRT_x", "head1",
                          "We believe this is a false positive") == machine


def test_survival_escalation_ignores_machine_dispositions(
        tmp_path, monkeypatch):
    """A machine `fix` disposition that failed verification breached
    survival — it must NOT satisfy the escalation (vacuous relaunch), but
    a subsequent human ruling must."""
    import collect_rulings
    import _common as c

    fix = ruling_fixdir(tmp_path, monkeypatch)
    out_dir = tmp_path / "review-loop"
    seed_loop(out_dir)
    c.write_json_atomic(out_dir / "escalation.json", {
        "schema": "escalation.v1", "kind": "survival",
        "generatedAt": c.now_iso(), "storyId": "STY-91",
        "headSha": "deadbeef" * 5,
        "items": [{"fingerprint": "PRRT_m", "path": "a.ts", "line": 1,
                   "reason": "survived 2 rounds", "rootCommentId": 111}],
    })
    seed_dispositions(out_dir, [
        {"fingerprint": "PRRT_m", "disposition": "fix",
         "evidence": {"commitSha": "0" * 40, "testId": "stale.e2e"}}])
    thread_table(fix, {"PRRT_m": {"comments": [
        comment("finding", author=BOT, association="NONE", cid=111)]}})

    assert collect_rulings.main(["--out", str(out_dir)]) == 1  # outstanding

    thread_table(fix, {"PRRT_m": {"comments": [
        comment("finding", author=BOT, association="NONE", cid=111),
        comment("/rule outdated_fixed — verified gone at head", cid=112),
    ]}})
    assert collect_rulings.main(["--out", str(out_dir)]) == 0


# -------------------------------------------------------------------- LOW-3

def test_owner_quote_reply_of_ask_still_rules(tmp_path, monkeypatch):
    import collect_rulings
    import _common as c

    RULER = {"login": "rayshawnmccall21", "id": 25748047}
    marker = c.ruling_request_marker("PRRT_x", "h")
    ask = comment(f"**Human ruling requested** — details\n\n{marker}",
                  created="2026-08-18T10:00:00Z", cid=2)
    quote_reply = comment(
        f"/rule defer — tracked as STY-140\n\n> **Human ruling requested**\n> {marker}",
        created="2026-08-18T11:00:00Z", cid=3)
    winner, _ = collect_rulings.select_ruling(
        [comment("finding", author=BOT, association="NONE", cid=1),
         ask, quote_reply], RULER)
    assert winner is not None
    assert winner[0]["databaseId"] == 3
    assert winner[1][0] == "defer"


# -------------------------------------------------------------------- LOW-4

def test_fp_ratio_uses_machine_denominator(fixture_ledger, out_dir):
    import classify_findings
    import _common as c
    import approval_gate

    assert classify_findings.main(["--out", str(out_dir)]) == 0
    queue = json.loads((out_dir / "queue.json").read_text())
    fps = [i["fingerprint"] for i in queue["blocking"]]
    ruled_by = {"login": "rayshawnmccall21", "id": 25748047,
                "commentId": 1, "bodySha256": "ab" * 32, "ruledAt": "x"}
    # 3 machine FPs out of 7 machine dispositions (0.43 > 0.30) — five
    # human-ruled FPs must not dilute the ratio below the breaker
    disp = ([{"fingerprint": fp, "disposition": "false_positive",
              "evidence": {"rationale": "model belief"}} for fp in fps[:3]]
            + [{"fingerprint": fp, "disposition": "fix",
                "evidence": {"commitSha": "0" * 40, "testId": "t"}}
               for fp in fps[3:7]]
            + [{"fingerprint": fp, "disposition": "false_positive",
                "evidence": {"rationale": "owner"},
                "ruledBy": dict(ruled_by)} for fp in fps[7:12]])
    c.write_json_atomic(out_dir / "dispositions.json", {
        "schema": "dispositions.v1", "storyId": "STY-91",
        "dispositions": disp})
    assert approval_gate.main([
        "--pr", "561", "--repo", "rayshawnmccall21/StylePassV2",
        "--out", str(out_dir), "--mode", "final", "--allow-detached"]) == 2


# -------------------------------------------------------------------- LOW-5

def test_reply_and_resolve_without_root_fails_closed(tmp_path, monkeypatch):
    import reconcile_threads

    fix = ruling_fixdir(tmp_path, monkeypatch)
    thread_table(fix, {})
    failed = reconcile_threads.apply_live(
        [{"fingerprint": "PRRT_x", "action": "reply_and_resolve",
          "reply": "evidence text"}],  # no commentId — no root known
        {}, "o/r", 1, head="h")
    assert failed == ["PRRT_x"]
    assert not (fix / "resolved.jsonl").exists()


# -------------------------------------------------------------------- LOW-6

def test_organization_ruler_is_refused(tmp_path, monkeypatch):
    import collect_rulings

    fix = ruling_fixdir(tmp_path, monkeypatch)
    (fix / "ruler.json").write_text(json.dumps(
        {"login": "some-org", "id": 999, "type": "Organization"}))
    out_dir = tmp_path / "review-loop"
    seed_loop(out_dir)
    seed_escalation(out_dir, [
        {"fingerprint": "PRRT_a", "path": "a.ts", "line": 1,
         "reason": "r", "rootCommentId": 111}])
    seed_dispositions(out_dir, [])
    thread_table(fix, {"PRRT_a": {"comments": []}})
    assert collect_rulings.main(["--out", str(out_dir)]) == 3
