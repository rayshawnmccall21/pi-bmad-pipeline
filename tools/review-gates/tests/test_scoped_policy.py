"""Scoped blocking policy — severity x category x path.

CodeRabbit's own published precision is ~33%, so its undifferentiated
stream cannot gate a merge (Google disables an analyzer above 25% effective
false positives, and requires ~0% to block a build). The gate therefore
blocks on a scoped subset and records the rest as advisory:

  blocks: severity CRITICAL anywhere
        | severity HIGH in product paths
        | Security & Privacy category anywhere, any severity
  advisory: everything else (still reported, auto-deferred with a debt note)

Default policy stays `all` so existing pipelines are unchanged; the RunDef
opts in with --blocking-policy scoped.
"""

import json

import pytest


def ledger(threads, out_dir):
    import _common as c

    c.write_json_atomic(out_dir / "ledger.json", {
        "schema": "review-ledger.v1",
        "generatedAt": "2026-08-18T00:00:00Z",
        "storyId": "STY-91",
        "pr": {"repo": "o/r", "number": 561, "headSha": "a" * 40,
               "branch": "b", "state": "OPEN", "isDraft": False},
        "review": {"id": 1, "state": "CHANGES_REQUESTED", "commitId": "a" * 40,
                   "submittedAt": "x", "matchesHead": True,
                   "advertisedActionable": len(threads)},
        "threads": threads,
        "outsideDiff": [],
        "counts": {"threads": len(threads), "unresolved": len(threads),
                   "outsideDiff": 0, "pages": 1},
    })


def thread(fp, path, marker, title="**Something is wrong.**", category="🎯 Functional Correctness"):
    return {
        "fingerprint": fp, "isResolved": False, "isOutdated": False,
        "path": path, "line": 10, "author": "coderabbitai",
        "excerpt": f"_{category}_ | _{marker}_ | _⚡ Quick win_\n\n{title}\n\nbody",
        "commentIds": [int(abs(hash(fp)) % 10**6)],
    }


CASES = [
    # (fingerprint, path, severity marker, category, expected bucket)
    ("PRRT_crit_tool", ".pi/bmad/x.py", "🔴 Critical", "🎯 Functional Correctness", "blocking"),
    ("PRRT_high_prod", "apps/mobile-barber/src/a.ts", "🟠 Major", "🗄️ Data Integrity & Integration", "blocking"),
    ("PRRT_high_mig", "supabase/migrations/1.sql", "🟠 Major", "🩺 Stability & Availability", "blocking"),
    ("PRRT_sec_tool", "qa/server.mjs", "🔵 Trivial", "🔒 Security & Privacy", "blocking"),
    ("PRRT_sec_mig", "supabase/migrations/2.sql", "🟡 Minor", "🔒 Security & Privacy", "blocking"),
    ("PRRT_high_tool", "qa/orchestrator/s.py", "🟠 Major", "🩺 Stability & Availability", "advisory"),
    ("PRRT_med_prod", "apps/web/x.tsx", "🟡 Minor", "📐 Maintainability & Code Quality", "advisory"),
    ("PRRT_med_tool", ".pi/qa/ARCHITECTURE.md", "🟡 Minor", "📐 Maintainability & Code Quality", "advisory"),
    ("PRRT_info_tool", "tools/qa-mock-server/src/i.test.ts", "🔵 Trivial", "📐 Maintainability & Code Quality", "advisory"),
]


@pytest.fixture()
def classified(out_dir):
    import classify_findings

    ledger([thread(fp, p, m, category=c) for fp, p, m, c, _ in CASES], out_dir)
    assert classify_findings.main([
        "--out", str(out_dir), "--blocking-policy", "scoped"]) == 0
    return json.loads((out_dir / "queue.json").read_text())


@pytest.mark.parametrize("fp,path,marker,category,expected", CASES)
def test_scoped_policy_buckets(classified, fp, path, marker, category, expected):
    blocking = {i["fingerprint"] for i in classified["blocking"]}
    advisory = {i["fingerprint"] for i in classified.get("advisory", [])}
    assert fp in (blocking if expected == "blocking" else advisory), (
        f"{fp} ({marker}, {category}, {path}) should be {expected}")
    assert fp not in (advisory if expected == "blocking" else blocking)


def test_scoped_policy_partition_is_complete(classified):
    total = sum(len(classified[k]) for k in
                ("blocking", "advisory", "nonBlocking", "excluded", "humanThreads"))
    assert total == len(CASES)
    assert len(classified["blocking"]) == 5
    assert len(classified["advisory"]) == 4
    assert classified["meta"]["blockingPolicy"] == "scoped"


def test_default_policy_blocks_everything(out_dir):
    import classify_findings

    ledger([thread(fp, p, m, category=c) for fp, p, m, c, _ in CASES], out_dir)
    assert classify_findings.main(["--out", str(out_dir)]) == 0
    q = json.loads((out_dir / "queue.json").read_text())
    assert len(q["blocking"]) == len(CASES)      # unchanged legacy behaviour
    assert q.get("advisory") == []
    assert q["meta"]["blockingPolicy"] == "all"


def test_product_paths_are_configurable(out_dir):
    import classify_findings

    ledger([thread(*c[:3], category=c[3]) for c in CASES], out_dir)
    assert classify_findings.main([
        "--out", str(out_dir), "--blocking-policy", "scoped",
        "--product-paths", "qa/"]) == 0
    q = json.loads((out_dir / "queue.json").read_text())
    blocking = {i["fingerprint"] for i in q["blocking"]}
    assert "PRRT_high_tool" in blocking      # qa/ is product now
    assert "PRRT_high_prod" not in blocking  # apps/ no longer is


def test_advisory_items_carry_reason(classified):
    for item in classified["advisory"]:
        assert item["advisoryReason"]
        assert "severity" in item and "path" in item


def test_outside_diff_defaults_to_advisory_under_scoped(out_dir):
    """od: findings have no thread to rule on and no severity marker we can
    trust — they must never block a merge under the scoped policy."""
    import _common as c
    import classify_findings

    ledger([thread("PRRT_x", "apps/a.ts", "🟠 Major")], out_dir)
    doc = json.loads((out_dir / "ledger.json").read_text())
    doc["outsideDiff"] = [{"fingerprint": "od:abc123", "reviewId": 1,
                           "file": "docs/x.md", "lines": "1-2",
                           "excerpt": "drift note"}]
    doc["counts"]["outsideDiff"] = 1
    c.write_json_atomic(out_dir / "ledger.json", doc)
    assert classify_findings.main([
        "--out", str(out_dir), "--blocking-policy", "scoped"]) == 0
    q = json.loads((out_dir / "queue.json").read_text())
    assert {i["fingerprint"] for i in q["advisory"]} == {"od:abc123"}
    assert {i["fingerprint"] for i in q["blocking"]} == {"PRRT_x"}
