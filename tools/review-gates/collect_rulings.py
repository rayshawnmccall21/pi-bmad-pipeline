#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""collect_rulings.py — one poll pass over the ruling threads.

The PR is the terminal; the threads are the prompt. The approval gate wrote
escalation.json enumerating the findings a human owes a ruling on; the
operator replies on those threads with

    /rule <fix|false_positive|outdated_fixed|duplicate|defer> — <reason>

and this tool translates accepted rulings into dispositions.json (the only
sanctioned human-writable surface), leaving an append-only audit trail in
ruling-receipts.jsonl and a consumed-set in rulings.json.

Acceptance is fail-closed: author must be a User whose login AND immutable
databaseId match the pinned ruler AND whose authorAssociation is OWNER; the
comment must not be minimized, must not be a machine ask (marker), and must
postdate the ask when one exists. Multiple valid rulings: latest createdAt
wins, earlier are receipted as superseded. Accepted rulings are pinned by
body hash; a later edit is receipted for audit, never re-executed.

Translation:
  fix            -> the needs_human disposition is REMOVED so the finding
                    re-enters the blocking flow (dev-story fixes, reconcile
                    verifies evidence); the fingerprint's survival counter
                    resets — a human fix-ruling buys one more argued round.
  false_positive -> disposition false_positive + ruledBy (reconcile resolves
                    it: the owner is the final arbiter, unlike machine FPs)
  outdated_fixed -> disposition outdated_fixed + ruledBy
  duplicate      -> disposition duplicate (+canonicalFingerprint) + ruledBy
  defer          -> disposition defer + ruledBy (reply-with-debt-note +
                    resolve at reconcile; human-only by construction)

No GitHub writes, ever. Exit: 0 all pending rulings collected · 1 rulings
still outstanding (poll again later) · 3 terminal (bad input, identity
change, API failure).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as c  # noqa: E402

RULE_RE = re.compile(
    r"^/rule[ \t]+(fix|false_positive|outdated_fixed|duplicate|defer)\b"
    r"(?:[ \t]*[—–:-][ \t]*(\S.*))?[ \t]*$"
)
REASON_REQUIRED = {"false_positive", "duplicate", "defer"}
HUMAN_VERBS = ("fix", "false_positive", "outdated_fixed", "duplicate", "defer")


def parse_rule_line(body: str) -> tuple[str, str] | None:
    """First non-empty line decides; anything else is prose, not a ruling."""
    for line in (body or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if not line.strip():
            continue
        m = RULE_RE.match(line)
        if not m:
            return None
        verb, reason = m.group(1), (m.group(2) or "").strip()
        if verb in REASON_REQUIRED and not reason:
            return None
        return verb, reason
    return None


def is_authorized(comment: dict, ruler: dict) -> bool:
    """All four checks, fail closed (login pins are belt AND suspenders:
    logins can be renamed and re-registered; databaseId cannot)."""
    author = comment.get("author") or {}
    return (
        author.get("__typename") == "User"
        and author.get("databaseId") == ruler["id"]
        and author.get("login") == ruler["login"]
        and comment.get("authorAssociation") == "OWNER"
        and not comment.get("isMinimized")
    )


def is_ask(comment: dict) -> bool:
    """Our ask, not merely a comment that CONTAINS the marker — a GitHub
    quote-reply copies HTML comments, and the ruler quoting the ask must
    not self-suppress their ruling."""
    body = comment.get("body") or ""
    return (c.RULING_REQUEST_MARKER_PREFIX in body
            and body.lstrip().startswith("**Human ruling requested**"))


def select_ruling(comments: list[dict], ruler: dict):
    """Returns ((winner_comment, (verb, reason)) | None, superseded)."""
    ask_at = None
    for cm in comments:
        if is_ask(cm):
            ask_at = max(ask_at or "", cm.get("createdAt") or "")
    candidates = []
    for cm in comments:
        body = cm.get("body") or ""
        if is_ask(cm):
            continue  # the ask itself (operator-authored) never rules
        if not is_authorized(cm, ruler):
            continue
        if ask_at and (cm.get("createdAt") or "") <= ask_at:
            continue  # rulings must postdate the ask when one exists
        parsed = parse_rule_line(body)
        if not parsed:
            continue
        candidates.append(
            ((cm.get("createdAt") or "", cm.get("databaseId") or 0), cm, parsed))
    if not candidates:
        return None, []
    candidates.sort(key=lambda t: t[0])
    winner = candidates[-1]
    return (winner[1], winner[2]), [cand[1] for cand in candidates[:-1]]


def evidence_for(verb: str, reason: str) -> dict:
    if verb == "duplicate":
        token = (reason.split() or [""])[0]
        ev = {"rationale": reason}
        if token.startswith(("PRRT_", "od:")):
            ev["canonicalFingerprint"] = token
        return ev
    return {"rationale": reason or f"ruled {verb} by owner"}


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text())


def append_receipt(out_dir: Path, receipt: dict) -> None:
    path = out_dir / "ruling-receipts.jsonl"
    with path.open("a") as fh:
        fh.write(json.dumps({"at": c.now_iso(), **receipt},
                            sort_keys=False) + "\n")


def pending_items(out_dir: Path, state: dict) -> tuple[list[dict], dict | None]:
    """The gate's escalation enumeration is the authoritative ask list;
    fall back to reconcile-plan needs_human actions when it is absent.
    A stale or foreign escalation (wrong head, wrong story) escalates —
    old-thread rulings must never be consumed into the current loop."""
    esc = load_json(out_dir / "escalation.json", None)
    if esc is not None:
        if esc.get("schema") != "escalation.v1":
            c.die(c.EXIT_FAIL, "escalation.json is not escalation.v1")
        if state.get("expectedHead") and \
                esc.get("headSha") != state["expectedHead"]:
            c.die(c.EXIT_ESCALATE,
                  f"escalation head {(esc.get('headSha') or '?')[:10]} != "
                  f"loop head {state['expectedHead'][:10]} — stale, "
                  "re-run the approval gate")
        if state.get("storyId") and esc.get("storyId") and \
                esc["storyId"] != state["storyId"]:
            c.die(c.EXIT_ESCALATE,
                  f"escalation story {esc['storyId']} != loop story "
                  f"{state['storyId']} — foreign escalation")
        return esc.get("items") or [], esc
    plan = load_json(out_dir / "reconcile-plan.json", None)
    if plan is None:
        return [], None
    queue = load_json(out_dir / "queue.json", {"blocking": []})
    by_fp = {i["fingerprint"]: i for i in queue.get("blocking") or []}
    ledger = load_json(out_dir / "ledger.json", {"threads": []})
    roots = {t["fingerprint"]: (t.get("commentIds") or [None])[0]
             for t in ledger.get("threads") or []}
    return [{
        "fingerprint": a["fingerprint"],
        "path": (by_fp.get(a["fingerprint"]) or {}).get("path"),
        "line": (by_fp.get(a["fingerprint"]) or {}).get("line"),
        "reason": a.get("reason") or "",
        "rootCommentId": roots.get(a["fingerprint"]),
    } for a in plan.get("actions") or []
        if a.get("action") == "needs_human"], None


def resolve_ruler(state: dict, rulings: dict,
                  override_login: str | None) -> dict:
    login = override_login or state["repo"].split("/")[0]
    user = c.gh_json(["api", f"users/{login}"])
    if user.get("type") == "Organization":
        c.die(c.EXIT_FAIL,
              f"repo owner '{login}' is an Organization — no comment can "
              "ever satisfy the User+OWNER ruler pin; pass --ruler-login "
              "with the human owner's login")
    ruler = {"login": login, "id": user["id"]}
    pinned = rulings.get("ruler")
    if pinned and (pinned.get("login") != ruler["login"]
                   or pinned.get("id") != ruler["id"]):
        c.die(c.EXIT_FAIL,
              f"ruler identity changed since pinning ({pinned} -> {ruler}) "
              "— refusing to accept rulings")
    return ruler


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--ruler-login", default=None,
                    help="defaults to the repo owner from loop-state")
    args = ap.parse_args(argv)
    out_dir = Path(args.out)

    state = c.loop_state_load(out_dir)
    if not state:
        print("review-gates: no loop-state.json — nothing to collect",
              file=sys.stderr)
        return c.EXIT_FAIL

    rulings = load_json(out_dir / "rulings.json",
                        {"schema": "rulings.v1", "ruler": None, "rulings": {}})
    try:
        items, esc = pending_items(out_dir, state)
    except SystemExit as err:
        return int(err.code)
    if not items:
        print("review-gates: no ruling-eligible escalation — nothing pending")
        return c.EXIT_OK
    esc_epoch = (esc or {}).get("generatedAt") or ""
    # The fallback source enumerates needs_human plan actions, so it shares
    # that kind's satisfaction semantics.
    esc_kind = esc.get("kind") if esc else "needs_human"

    try:
        ruler = resolve_ruler(state, rulings, args.ruler_login)
    except SystemExit as err:
        return int(err.code)
    except c.GhError as err:
        print(f"review-gates: ruler lookup failed: {err}", file=sys.stderr)
        return c.EXIT_FAIL

    consumed = rulings["rulings"]
    disp_path = out_dir / "dispositions.json"
    disp_doc = load_json(disp_path, {
        "schema": "dispositions.v1", "storyId": state.get("storyId"),
        "dispositions": []})
    disp_by_fp = {d.get("fingerprint"): d for d in disp_doc["dispositions"]}

    def satisfied(fp: str) -> bool:
        """A consumed ruling satisfies its OWN escalation epoch only — a
        re-escalated fingerprint needs a fresh ruling (never a vacuous
        relaunch). A dispositions.json entry satisfies only when it is
        human-attributable: ruledBy present, or a needs_human-kind item
        (whose entry can only have moved off needs_human by the sanctioned
        hand-edit — the ruling path for non-thread od: findings). A MACHINE
        disposition never satisfies a survival escalation: the gate already
        saw it and breached anyway."""
        ruling = consumed.get(fp)
        if ruling and (not esc_epoch
                       or (ruling.get("ruledAt") or "") >= esc_epoch):
            return True
        entry = disp_by_fp.get(fp)
        if not entry or entry.get("disposition") == "needs_human":
            return False
        return bool(entry.get("ruledBy")) or esc_kind == "needs_human"

    outstanding = [i for i in items if not satisfied(i["fingerprint"])]
    try:
        nodes = c.fetch_thread_nodes([i["fingerprint"] for i in items])
    except c.GhError as err:
        print(f"review-gates: thread fetch failed: {err}", file=sys.stderr)
        return c.EXIT_FAIL
    receipts_path = out_dir / "ruling-receipts.jsonl"
    seen_receipts = set()
    if receipts_path.exists():
        for line in receipts_path.read_text().splitlines():
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            seen_receipts.add((r.get("kind"), r.get("commentId"),
                               r.get("bodySha256")))

    # ---- audit already-consumed rulings for edits and deletions ----------
    for fp, ruling in consumed.items():
        node = nodes.get(fp)
        if not node:
            continue
        found = False
        for cm in c.thread_comments(node):
            if cm.get("databaseId") != ruling.get("commentId"):
                continue
            found = True
            body_hash = c.sha256(cm.get("body") or "")
            if body_hash != ruling.get("bodySha256"):
                key = ("ruling_edited_after_acceptance",
                       cm.get("databaseId"), body_hash)
                if key not in seen_receipts:
                    append_receipt(out_dir, {
                        "kind": "ruling_edited_after_acceptance",
                        "fingerprint": fp,
                        "commentId": cm.get("databaseId"),
                        "bodySha256": body_hash,
                        "pinnedSha256": ruling.get("bodySha256"),
                    })
                    seen_receipts.add(key)
                print(f"review-gates: WARNING — accepted ruling on "
                      f"{fp[:24]} was edited after execution (audited, "
                      "not re-executed)", file=sys.stderr)
        if not found and c.thread_comments(node):
            key = ("ruling_comment_deleted", ruling.get("commentId"), "")
            if key not in seen_receipts:
                append_receipt(out_dir, {
                    "kind": "ruling_comment_deleted", "fingerprint": fp,
                    "commentId": ruling.get("commentId"),
                    "pinnedSha256": ruling.get("bodySha256")})
                seen_receipts.add(key)
            print(f"review-gates: WARNING — accepted ruling comment on "
                  f"{fp[:24]} is gone from the thread (deletion audited; "
                  "the ledger, not GitHub, is the record)", file=sys.stderr)

    # ---- accept new rulings ---------------------------------------------
    state_dirty = False
    accepted_now = []
    still_outstanding = []
    for item in outstanding:
        fp = item["fingerprint"]
        if not fp.startswith("PRRT_"):
            still_outstanding.append(fp)
            print(f"review-gates: {fp[:24]} is not a review thread — rule "
                  "it by editing dispositions.json directly",
                  file=sys.stderr)
            continue
        node = nodes.get(fp)
        if not node:
            still_outstanding.append(fp)
            print(f"review-gates: thread {fp[:24]} not fetchable — "
                  "still outstanding", file=sys.stderr)
            continue
        winner, superseded = select_ruling(c.thread_comments(node), ruler)
        for cm in superseded:
            key = ("ruling_superseded", cm.get("databaseId"),
                   c.sha256(cm.get("body") or ""))
            if key not in seen_receipts:
                append_receipt(out_dir, {
                    "kind": "ruling_superseded", "fingerprint": fp,
                    "commentId": cm.get("databaseId"),
                    "bodySha256": key[2]})
                seen_receipts.add(key)
        if not winner:
            still_outstanding.append(fp)
            continue
        cm, (verb, reason) = winner
        prev = consumed.get(fp)
        if prev and cm.get("databaseId") == prev.get("commentId"):
            # A re-escalated fingerprint needs a NEW ruling; the old
            # consumed comment is never re-executed.
            still_outstanding.append(fp)
            print(f"review-gates: {fp[:24]} re-escalated — its previous "
                  "ruling was already executed; awaiting a fresh /rule "
                  "reply", file=sys.stderr)
            continue
        body_hash = c.sha256(cm.get("body") or "")
        ruled_by = {
            "login": ruler["login"], "id": ruler["id"],
            "commentId": cm.get("databaseId"),
            "bodySha256": body_hash,
            "ruledAt": c.now_iso(),
        }
        # translate
        if fp in disp_by_fp:
            disp_doc["dispositions"] = [
                d for d in disp_doc["dispositions"]
                if d.get("fingerprint") != fp]
        if verb == "fix":
            fps = dict(state.get("fingerprints") or {})
            fps[fp] = {"survived": 0}
            state["fingerprints"] = fps
            state_dirty = True
        else:
            disp_doc["dispositions"].append({
                "fingerprint": fp, "disposition": verb,
                "evidence": evidence_for(verb, reason),
                "ruledBy": ruled_by,
            })
        disp_by_fp = {d.get("fingerprint"): d
                      for d in disp_doc["dispositions"]}
        rulings["rulings"][fp] = {
            "verb": verb, "reason": reason,
            "commentId": cm.get("databaseId"), "bodySha256": body_hash,
            "ruledAt": ruled_by["ruledAt"],
        }
        append_receipt(out_dir, {
            "kind": "ruling_accepted", "fingerprint": fp, "verb": verb,
            "reason": reason, "commentId": cm.get("databaseId"),
            "bodySha256": body_hash,
            "bodyText": c.sanitize_text(cm.get("body") or "", 2000),
            "commentCreatedAt": cm.get("createdAt"),
            "lastEditedAt": cm.get("lastEditedAt"),
            "ruler": dict(ruler),
        })
        accepted_now.append((fp, verb))

    # Persist in crash-safe order: loop-state (survival resets) first,
    # dispositions next, the consumed-set LAST — a crash mid-sequence
    # leaves a re-collectable ruling, never a consumed-but-unapplied one.
    if state_dirty:
        state["updatedAt"] = c.now_iso()
        c.loop_state_save(out_dir, state)
    c.write_json_atomic(disp_path, disp_doc)
    rulings["ruler"] = ruler
    c.write_json_atomic(out_dir / "rulings.json", rulings)

    total = len(items)
    done = total - len(still_outstanding)
    print(f"review-gates: rulings {done}/{total} collected "
          f"({', '.join(f'{fp[:20]}={verb}' for fp, verb in accepted_now) or 'none new'})"
          + (f"; outstanding: {', '.join(fp[:20] for fp in still_outstanding)}"
             if still_outstanding else ""))
    return c.EXIT_OK if not still_outstanding else c.EXIT_GATE


if __name__ == "__main__":
    raise SystemExit(main())
