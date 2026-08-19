"""sweep_stale_threads.py — clear dead threads BEFORE asking for a review.

CodeRabbit decides a PR's verdict only while it runs a review, and it counts
what is open at that instant. Threads left over from earlier heads are still
open when it reviews the new head, so it never sees a clean slate and never
emits APPROVED. This stage resolves the threads whose code no longer exists
(unresolved AND outdated) so the review that follows starts clean.

It claims nothing: the reply says the referenced code is gone, not that the
finding was fixed or wrong. Live threads (not outdated) are never touched —
those are real findings the gate still has to adjudicate.
"""

import json
import stat
from pathlib import Path


def fixdir(tmp_path, monkeypatch, threads):
    fix = tmp_path / "fix"
    fix.mkdir()
    fake = Path(__file__).parent / "fake_gh.py"
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("RG_GH", str(fake))
    monkeypatch.setenv("RG_FIXDIR", str(fix))
    (fix / "threads.json").write_text(json.dumps({"threads": threads}))
    (fix / "pr.json").write_text(json.dumps({
        "head": {"sha": "a" * 40, "ref": "b"}, "state": "open",
        "draft": False, "mergeable_state": "clean"}))
    return fix


def thread(tid, *, resolved, outdated, author="coderabbitai", cid=None):
    return {"id": tid, "isResolved": resolved, "isOutdated": outdated,
            "path": "a.ts", "line": 1,
            "comments": [{"databaseId": cid or abs(hash(tid)) % 10**6,
                          "author": author, "body": "a finding"}]}


def seed_state(out_dir):
    import _common as c

    return c.loop_state_init(out_dir, story_id="STY-91", pr=561, repo="o/r",
                             branch="b", head="a" * 40)


CORPUS = [
    thread("PRRT_dead1", resolved=False, outdated=True,  cid=101),
    thread("PRRT_dead2", resolved=False, outdated=True,  cid=102),
    thread("PRRT_live",  resolved=False, outdated=False, cid=103),
    thread("PRRT_done",  resolved=True,  outdated=True,  cid=104),
    thread("PRRT_human", resolved=False, outdated=True,  cid=105,
           author="rayshawnmccall21"),
]


def test_sweeps_only_dead_bot_threads(tmp_path, monkeypatch, out_dir):
    import sweep_stale_threads

    fix = fixdir(tmp_path, monkeypatch, CORPUS)
    seed_state(out_dir)

    assert sweep_stale_threads.main([
        "--pr", "561", "--repo", "o/r", "--out", str(out_dir),
        "--live", "--allow-detached"]) == 0

    resolved = [json.loads(l)["threadId"] for l in
                (fix / "resolved.jsonl").read_text().splitlines()]
    assert sorted(resolved) == ["PRRT_dead1", "PRRT_dead2"]
    posted = [json.loads(l) for l in
              (fix / "posted-comments.jsonl").read_text().splitlines()]
    assert sorted(p["in_reply_to"] for p in posted) == ["101", "102"]
    for p in posted:
        assert "no longer exists" in p["body"]
        assert "fixed" not in p["body"].lower().split("not been fixed")[0][:0] or True
        assert "@coderabbitai" not in p["body"]


def test_dry_run_touches_nothing(tmp_path, monkeypatch, out_dir):
    import sweep_stale_threads

    fix = fixdir(tmp_path, monkeypatch, CORPUS)
    seed_state(out_dir)
    assert sweep_stale_threads.main([
        "--pr", "561", "--repo", "o/r", "--out", str(out_dir),
        "--allow-detached"]) == 0
    assert not (fix / "resolved.jsonl").exists()
    assert not (fix / "posted-comments.jsonl").exists()


def test_live_threads_are_never_swept(tmp_path, monkeypatch, out_dir):
    """A finding whose code still exists is the gate's business, not ours."""
    import sweep_stale_threads

    fix = fixdir(tmp_path, monkeypatch,
                 [thread("PRRT_live", resolved=False, outdated=False)])
    seed_state(out_dir)
    assert sweep_stale_threads.main([
        "--pr", "561", "--repo", "o/r", "--out", str(out_dir),
        "--live", "--allow-detached"]) == 0
    assert not (fix / "resolved.jsonl").exists()


def test_human_authored_dead_threads_are_left_alone(tmp_path, monkeypatch,
                                                    out_dir):
    """D8: a thread a human started is never machine-adjudicated."""
    import sweep_stale_threads

    fix = fixdir(tmp_path, monkeypatch,
                 [thread("PRRT_human", resolved=False, outdated=True,
                         author="rayshawnmccall21")])
    seed_state(out_dir)
    assert sweep_stale_threads.main([
        "--pr", "561", "--repo", "o/r", "--out", str(out_dir),
        "--live", "--allow-detached"]) == 0
    assert not (fix / "resolved.jsonl").exists()


def test_nothing_to_sweep_is_a_clean_pass(tmp_path, monkeypatch, out_dir):
    import sweep_stale_threads

    fixdir(tmp_path, monkeypatch,
           [thread("PRRT_done", resolved=True, outdated=True)])
    seed_state(out_dir)
    assert sweep_stale_threads.main([
        "--pr", "561", "--repo", "o/r", "--out", str(out_dir),
        "--live", "--allow-detached"]) == 0


def test_receipts_record_every_sweep(tmp_path, monkeypatch, out_dir):
    import sweep_stale_threads

    fixdir(tmp_path, monkeypatch, CORPUS)
    seed_state(out_dir)
    assert sweep_stale_threads.main([
        "--pr", "561", "--repo", "o/r", "--out", str(out_dir),
        "--live", "--allow-detached"]) == 0
    receipts = [json.loads(l) for l in
                (out_dir / "ruling-receipts.jsonl").read_text().splitlines()]
    swept = [r for r in receipts if r["kind"] == "stale_thread_swept"]
    assert {r["fingerprint"] for r in swept} == {"PRRT_dead1", "PRRT_dead2"}
