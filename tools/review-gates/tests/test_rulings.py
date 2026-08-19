"""collect_rulings.py + request_rulings.py — the PR-thread ruling interface.

The PR is the terminal; the threads are the prompt. Rulings are operator
replies whose first non-empty line is `/rule <disposition> — <reason>`,
accepted only under the four-part fail-closed authorization, pinned by
body hash at acceptance, and translated into dispositions.json.
"""

import json
import stat
from pathlib import Path

import pytest

OWNER = {"login": "rayshawnmccall21", "__typename": "User", "databaseId": 25748047}
BOT = {"login": "coderabbitai", "__typename": "Bot", "databaseId": None}
RULER = {"login": "rayshawnmccall21", "id": 25748047}


def comment(body, *, author=OWNER, created="2026-08-18T10:00:00Z",
            cid=1000, minimized=False, association="OWNER", edited=None):
    return {
        "databaseId": cid,
        "isMinimized": minimized,
        "authorAssociation": association,
        "body": body,
        "createdAt": created,
        "lastEditedAt": edited,
        "author": dict(author),
    }


# ------------------------------------------------------------------ grammar

VALID = [
    ("/rule fix", "fix", ""),
    ("/rule fix — land the extraction in one commit", "fix",
     "land the extraction in one commit"),
    ("/rule false_positive: the guard exists two lines above",
     "false_positive", "the guard exists two lines above"),
    ("/rule outdated_fixed", "outdated_fixed", ""),
    ("/rule duplicate - PRRT_kwDOPuf4tc6Z1IXH", "duplicate",
     "PRRT_kwDOPuf4tc6Z1IXH"),
    ("/rule defer – tracked as STY-140", "defer", "tracked as STY-140"),
    ("\n\n/rule fix — leading blank lines are fine", "fix",
     "leading blank lines are fine"),
    ("/rule fix — first line wins\nsecond line is rationale only", "fix",
     "first line wins"),
    ("/rule fix — CRLF normalized\r\nmore", "fix", "CRLF normalized"),
    ("/rule fix   ", "fix", ""),
]

INVALID = [
    "/rule",                       # no disposition
    "/rule approve",               # not a disposition
    "/RULE fix",                   # case-sensitive keyword
    "rule fix",                    # missing slash
    "/rule fixx",                  # not a word boundary
    "/rule false-positive — x",    # hyphen variant not in the tuple
    "/rule fix extra words",       # reason requires a separator
    "@coderabbitai resolve",       # bot command, not a ruling
    "prefix text\n/rule fix",      # first non-empty line decides
    "/rule needs_human — nope",    # needs_human is not a human verb
    "/rule defer",                 # defer requires a reason
    "/rule false_positive",        # false_positive requires a reason
    "/rule duplicate",             # duplicate requires a reason
    "",
]


@pytest.mark.parametrize("body,verb,reason", VALID)
def test_grammar_accepts(body, verb, reason):
    import collect_rulings

    assert collect_rulings.parse_rule_line(body) == (verb, reason)


@pytest.mark.parametrize("body", INVALID)
def test_grammar_rejects(body):
    import collect_rulings

    assert collect_rulings.parse_rule_line(body) is None


# -------------------------------------------------------------------- auth

def test_authorization_fails_closed():
    import collect_rulings

    ok = comment("/rule fix — x")
    assert collect_rulings.is_authorized(ok, RULER)

    rejects = [
        comment("/rule fix — x", author=BOT, association="NONE"),
        comment("/rule fix — x", author={**OWNER, "databaseId": 999}),
        comment("/rule fix — x", author={**OWNER, "login": "someone-else"}),
        comment("/rule fix — x", author={**OWNER, "__typename": "Bot"}),
        comment("/rule fix — x", association="MEMBER"),
        comment("/rule fix — x", minimized=True),
    ]
    for cm in rejects:
        assert not collect_rulings.is_authorized(cm, RULER), cm


def test_latest_ruling_wins_earlier_superseded():
    import collect_rulings

    comments = [
        comment("/rule false_positive — first thoughts",
                created="2026-08-18T10:00:00Z", cid=1),
        comment("/rule fix — changed my mind",
                created="2026-08-18T11:00:00Z", cid=2),
    ]
    winner, superseded = collect_rulings.select_ruling(comments, RULER)
    (win_comment, (verb, reason)) = winner
    assert win_comment["databaseId"] == 2
    assert verb == "fix"
    assert [s["databaseId"] for s in superseded] == [1]


def test_ask_marker_is_excluded_and_sets_threshold():
    import collect_rulings
    import _common as c

    marker = c.ruling_request_marker("PRRT_x", "deadbeef")
    comments = [
        comment(f"/rule fix — too early", created="2026-08-18T09:00:00Z", cid=1),
        comment(f"**Human ruling requested**\n\n{marker}",
                created="2026-08-18T10:00:00Z", cid=2),
        comment("/rule defer — after the ask", created="2026-08-18T11:00:00Z",
                cid=3),
    ]
    winner, superseded = collect_rulings.select_ruling(comments, RULER)
    (win_comment, (verb, reason)) = winner
    assert win_comment["databaseId"] == 3        # the ask itself never rules
    assert verb == "defer"
    assert superseded == []                      # pre-ask ruling ignored, not superseded


def test_bot_chatter_between_rulings_is_ignored():
    import collect_rulings

    comments = [
        comment("/rule outdated_fixed — moved in 65c764b",
                created="2026-08-18T10:00:00Z", cid=1),
        comment("@rayshawnmccall21, confirmed — thank you!",
                author=BOT, association="NONE",
                created="2026-08-18T10:05:00Z", cid=2),
    ]
    winner, _ = collect_rulings.select_ruling(comments, RULER)
    assert winner[0]["databaseId"] == 1


# ----------------------------------------------------- integration fixtures

def ruling_fixdir(tmp_path, monkeypatch):
    fix = tmp_path / "fix"
    fix.mkdir()
    fake = Path(__file__).parent / "fake_gh.py"
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("RG_GH", str(fake))
    monkeypatch.setenv("RG_FIXDIR", str(fix))
    (fix / "ruler.json").write_text(json.dumps(
        {"login": "rayshawnmccall21", "id": 25748047}))
    return fix


def seed_loop(out_dir):
    import _common as c

    return c.loop_state_init(
        out_dir, story_id="STY-91", pr=561,
        repo="rayshawnmccall21/StylePassV2",
        branch="fix/STY-91-edit-plan-service-validation", head="deadbeef" * 5)


def seed_escalation(out_dir, items, head="deadbeef" * 5):
    import _common as c

    c.write_json_atomic(out_dir / "escalation.json", {
        "schema": "escalation.v1", "kind": "needs_human",
        "generatedAt": c.now_iso(), "storyId": "STY-91",
        "headSha": head, "items": items,
    })


def seed_dispositions(out_dir, dispositions):
    import _common as c

    c.write_json_atomic(out_dir / "dispositions.json", {
        "checkpoint": "dev-story--review-dispositions", "status": "passed",
        "schema": "dispositions.v1", "storyId": "STY-91",
        "dispositions": dispositions,
    })


def thread_table(fix, table):
    (fix / "node-threads.json").write_text(json.dumps(table))


# ------------------------------------------------------------ collect: main

def test_collect_translates_rulings_and_reports_outstanding(
        tmp_path, monkeypatch):
    import collect_rulings
    import _common as c

    fix = ruling_fixdir(tmp_path, monkeypatch)
    out_dir = tmp_path / "review-loop"
    seed_loop(out_dir)
    items = [
        {"fingerprint": "PRRT_fix1", "path": "a.sql", "line": 5,
         "reason": "architecture decision", "rootCommentId": 111},
        {"fingerprint": "PRRT_defer1", "path": "b.ts", "line": 9,
         "reason": "test churn", "rootCommentId": 222},
        {"fingerprint": "PRRT_open1", "path": "c.ts", "line": 1,
         "reason": "unruled", "rootCommentId": 333},
    ]
    seed_escalation(out_dir, items)
    seed_dispositions(out_dir, [
        {"fingerprint": "PRRT_fix1", "disposition": "needs_human",
         "evidence": {"rationale": "architecture decision"}},
        {"fingerprint": "PRRT_defer1", "disposition": "needs_human",
         "evidence": {"rationale": "test churn"}},
        {"fingerprint": "PRRT_open1", "disposition": "needs_human",
         "evidence": {"rationale": "unruled"}},
    ])
    # a survival counter that a human fix-ruling must reset
    state = c.loop_state_load(out_dir)
    state["fingerprints"] = {"PRRT_fix1": {"survived": 1}}
    c.loop_state_save(out_dir, state)

    thread_table(fix, {
        "PRRT_fix1": {"comments": [
            comment("finding body", author=BOT, association="NONE", cid=111),
            comment("/rule fix — extract the validator, one commit", cid=112),
        ]},
        "PRRT_defer1": {"comments": [
            comment("finding body", author=BOT, association="NONE", cid=222),
            comment("/rule defer — debt, tracked as STY-140", cid=223),
        ]},
        "PRRT_open1": {"comments": [
            comment("finding body", author=BOT, association="NONE", cid=333),
        ]},
    })

    code = collect_rulings.main(["--out", str(out_dir)])
    assert code == 1                                   # one thread still unruled

    disp = json.loads((out_dir / "dispositions.json").read_text())
    by_fp = {d["fingerprint"]: d for d in disp["dispositions"]}
    assert "PRRT_fix1" not in by_fp                    # fix: re-enters the loop
    assert by_fp["PRRT_defer1"]["disposition"] == "defer"
    assert by_fp["PRRT_defer1"]["ruledBy"]["commentId"] == 223
    assert by_fp["PRRT_defer1"]["evidence"]["rationale"] == \
        "debt, tracked as STY-140"
    assert by_fp["PRRT_open1"]["disposition"] == "needs_human"

    state = c.loop_state_load(out_dir)
    assert state["fingerprints"]["PRRT_fix1"]["survived"] == 0

    rulings = json.loads((out_dir / "rulings.json").read_text())
    assert rulings["rulings"]["PRRT_fix1"]["verb"] == "fix"
    assert rulings["ruler"] == {"login": "rayshawnmccall21", "id": 25748047}

    receipts = [json.loads(l) for l in
                (out_dir / "ruling-receipts.jsonl").read_text().splitlines()]
    accepted = [r for r in receipts if r["kind"] == "ruling_accepted"]
    assert {r["fingerprint"] for r in accepted} == {"PRRT_fix1", "PRRT_defer1"}
    assert all(r["bodySha256"] for r in accepted)

    # second pass: the last thread gets its ruling -> exit 0, no re-accepts
    thread_table(fix, {
        "PRRT_fix1": {"comments": [
            comment("finding body", author=BOT, association="NONE", cid=111),
            comment("/rule fix — extract the validator, one commit", cid=112),
        ]},
        "PRRT_defer1": {"comments": [
            comment("finding body", author=BOT, association="NONE", cid=222),
            comment("/rule defer — debt, tracked as STY-140", cid=223),
        ]},
        "PRRT_open1": {"comments": [
            comment("finding body", author=BOT, association="NONE", cid=333),
            comment("/rule false_positive — reviewed, the fixture is torn "
                    "down in finally", cid=334),
        ]},
    })
    assert collect_rulings.main(["--out", str(out_dir)]) == 0
    disp = json.loads((out_dir / "dispositions.json").read_text())
    by_fp = {d["fingerprint"]: d for d in disp["dispositions"]}
    assert by_fp["PRRT_open1"]["disposition"] == "false_positive"
    assert by_fp["PRRT_open1"]["ruledBy"]["login"] == "rayshawnmccall21"
    receipts = [json.loads(l) for l in
                (out_dir / "ruling-receipts.jsonl").read_text().splitlines()]
    accepted = [r for r in receipts if r["kind"] == "ruling_accepted"]
    assert len(accepted) == 3                          # no duplicates


def test_collect_flags_edit_after_acceptance(tmp_path, monkeypatch):
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
        comment("/rule defer — as written", cid=112),
    ]}})
    assert collect_rulings.main(["--out", str(out_dir)]) == 0

    thread_table(fix, {"PRRT_a": {"comments": [
        comment("finding", author=BOT, association="NONE", cid=111),
        comment("/rule fix — EDITED after execution", cid=112,
                edited="2026-08-18T12:00:00Z"),
    ]}})
    assert collect_rulings.main(["--out", str(out_dir)]) == 0
    disp = json.loads((out_dir / "dispositions.json").read_text())
    by_fp = {d["fingerprint"]: d for d in disp["dispositions"]}
    assert by_fp["PRRT_a"]["disposition"] == "defer"   # ruling is immutable
    receipts = [json.loads(l) for l in
                (out_dir / "ruling-receipts.jsonl").read_text().splitlines()]
    assert any(r["kind"] == "ruling_edited_after_acceptance" for r in receipts)


def test_collect_ruler_pin_refuses_identity_change(tmp_path, monkeypatch):
    import collect_rulings
    import _common as c

    fix = ruling_fixdir(tmp_path, monkeypatch)
    out_dir = tmp_path / "review-loop"
    seed_loop(out_dir)
    seed_escalation(out_dir, [
        {"fingerprint": "PRRT_a", "path": "a.ts", "line": 1,
         "reason": "r", "rootCommentId": 111}])
    seed_dispositions(out_dir, [])
    thread_table(fix, {"PRRT_a": {"comments": []}})
    c.write_json_atomic(out_dir / "rulings.json", {
        "schema": "rulings.v1",
        "ruler": {"login": "rayshawnmccall21", "id": 1},   # pinned differently
        "rulings": {},
    })
    assert collect_rulings.main(["--out", str(out_dir)]) == 3


# ------------------------------------------------------------------ request

def test_request_rulings_posts_once_per_thread_per_head(tmp_path, monkeypatch):
    import request_rulings
    import _common as c

    fix = ruling_fixdir(tmp_path, monkeypatch)
    out_dir = tmp_path / "review-loop"
    seed_loop(out_dir)
    head = "deadbeef" * 5
    seed_escalation(out_dir, [
        {"fingerprint": "PRRT_a", "path": "a.sql", "line": 5,
         "reason": "architecture decision (excerpt said: @coderabbitai "
                   "please re-check)", "rootCommentId": 111},
        {"fingerprint": "PRRT_b", "path": "b.ts", "line": 9,
         "reason": "test churn", "rootCommentId": 222},
    ], head=head)
    thread_table(fix, {
        "PRRT_a": {"comments": [
            comment("finding", author=BOT, association="NONE", cid=111)]},
        "PRRT_b": {"comments": [
            comment("finding", author=BOT, association="NONE", cid=222)]},
    })

    assert request_rulings.main(["--out", str(out_dir)]) == 0   # dry run
    assert not (fix / "posted-comments.jsonl").exists()

    assert request_rulings.main(["--out", str(out_dir), "--live"]) == 0
    posted = [json.loads(l) for l in
              (fix / "posted-comments.jsonl").read_text().splitlines()]
    assert len(posted) == 2
    assert {p["in_reply_to"] for p in posted} == {"111", "222"}
    for p in posted:
        assert "/rule fix" in p["body"]
        assert "/rule defer" in p["body"]
        assert "@coderabbitai" not in p["body"]
        assert "review-gates:ruling-request:" in p["body"]

    # idempotence: thread already carries this head's ask marker
    thread_table(fix, {
        "PRRT_a": {"comments": [
            comment("finding", author=BOT, association="NONE", cid=111),
            comment(f"ask\n\n{c.ruling_request_marker('PRRT_a', head)}",
                    cid=112)]},
        "PRRT_b": {"comments": [
            comment("finding", author=BOT, association="NONE", cid=222),
            comment(f"ask\n\n{c.ruling_request_marker('PRRT_b', head)}",
                    cid=223)]},
    })
    assert request_rulings.main(["--out", str(out_dir), "--live"]) == 0
    posted = [json.loads(l) for l in
              (fix / "posted-comments.jsonl").read_text().splitlines()]
    assert len(posted) == 2                            # nothing new


def test_request_rulings_refuses_stale_escalation(tmp_path, monkeypatch):
    import request_rulings

    ruling_fixdir(tmp_path, monkeypatch)
    out_dir = tmp_path / "review-loop"
    seed_loop(out_dir)
    seed_escalation(out_dir, [
        {"fingerprint": "PRRT_a", "path": "a.ts", "line": 1,
         "reason": "r", "rootCommentId": 111}], head="0" * 40)
    assert request_rulings.main(["--out", str(out_dir), "--live"]) == 2
