#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""request_rulings.py — post the ruling ask on each escalated thread.

Reads escalation.json (written by the approval gate on every ruling-eligible
escalation: needs_human, survival) and replies once per thread per head with
the /rule instructions, anchored to the thread's root comment. Idempotent
via an HTML marker embedding (fingerprint, headSha); a thread that already
carries this head's ask is never asked twice. Threads that already hold an
accepted ruling (rulings.json) are skipped.

The ask never contains the string "@coderabbitai" — a mention is an
instruction to the bot; the ask is an instruction to the human.

Default is --dry-run (prints the plan, posts nothing). Exit: 0 asks posted
or nothing to ask · 2 escalation is stale relative to the loop head ·
3 terminal failure.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as c  # noqa: E402

ASK_TEMPLATE = """**Human ruling requested** — the automated loop could not disposition this finding.

Why: {reason}
Finding: `{where}`

Reply on THIS thread. The first line of your reply must be exactly one of:

    /rule fix — <what to fix / commit ref>
    /rule false_positive — <why the finding is wrong>
    /rule outdated_fixed — <where it is already fixed>
    /rule duplicate — <canonical thread id>
    /rule defer — <debt note + tracking ref (STY-xxx)>

Further lines are recorded as rationale. Only rulings from the repo owner
are honored; edits after execution are audited, never re-executed.

{marker}"""


def append_receipt(out_dir: Path, receipt: dict) -> None:
    with (out_dir / "ruling-receipts.jsonl").open("a") as fh:
        fh.write(json.dumps({"at": c.now_iso(), **receipt}) + "\n")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=True)
    mode.add_argument("--live", dest="dry_run", action="store_false")
    args = ap.parse_args(argv)
    out_dir = Path(args.out)

    state = c.loop_state_load(out_dir)
    if not state:
        print("review-gates: no loop-state.json", file=sys.stderr)
        return c.EXIT_FAIL
    esc_path = out_dir / "escalation.json"
    if not esc_path.exists():
        print("review-gates: no escalation.json — nothing to request")
        return c.EXIT_OK
    esc = json.loads(esc_path.read_text())
    if esc.get("schema") != "escalation.v1":
        print("review-gates: escalation.json is not escalation.v1",
              file=sys.stderr)
        return c.EXIT_FAIL
    head = esc.get("headSha") or ""
    if state.get("expectedHead") and head != state["expectedHead"]:
        print(f"review-gates: escalation head {head[:10]} != loop head "
              f"{state['expectedHead'][:10]} — stale, re-run the gate",
              file=sys.stderr)
        return c.EXIT_ESCALATE

    rulings = {}
    rulings_path = out_dir / "rulings.json"
    if rulings_path.exists():
        rulings = json.loads(rulings_path.read_text()).get("rulings") or {}
    disp_by_fp = {}
    disp_path = out_dir / "dispositions.json"
    if disp_path.exists():
        disp_by_fp = {d.get("fingerprint"): d for d in
                      json.loads(disp_path.read_text()).get("dispositions")
                      or []}
    esc_epoch = esc.get("generatedAt") or ""
    esc_kind = esc.get("kind") or "needs_human"

    def satisfied(fp: str) -> bool:
        # mirrors collect_rulings: a consumed ruling covers its own
        # escalation epoch only; entries satisfy only when human-
        # attributable (ruledBy, or hand-edited needs_human-kind items) —
        # machine dispositions never satisfy a survival escalation
        ruling = rulings.get(fp)
        if ruling and (not esc_epoch
                       or (ruling.get("ruledAt") or "") >= esc_epoch):
            return True
        entry = disp_by_fp.get(fp)
        if not entry or entry.get("disposition") == "needs_human":
            return False
        return bool(entry.get("ruledBy")) or esc_kind == "needs_human"

    items = [i for i in esc.get("items") or []
             if not satisfied(i["fingerprint"])]
    if not items:
        print("review-gates: every escalated thread already ruled — "
              "nothing to request")
        return c.EXIT_OK

    try:
        nodes = c.fetch_thread_nodes([i["fingerprint"] for i in items])
    except c.GhError as err:
        print(f"review-gates: thread fetch failed: {err}", file=sys.stderr)
        return c.EXIT_FAIL

    to_post = []
    for item in items:
        fp = item["fingerprint"]
        if not fp.startswith("PRRT_"):
            print(f"review-gates: {fp[:24]} is not a review thread — no ask "
                  "possible; rule it by editing dispositions.json",
                  file=sys.stderr)
            continue
        marker = c.ruling_request_marker(fp, head)
        node = nodes.get(fp)
        if node is None:
            print(f"review-gates: thread {fp[:24]} not fetchable — skipping "
                  "(cannot verify idempotence)", file=sys.stderr)
            continue
        comments = c.thread_comments(node)
        if any(marker in (cm.get("body") or "") for cm in comments):
            continue  # this head's ask is already on the thread
        root = item.get("rootCommentId")
        if not root and comments:
            root = comments[0].get("databaseId")
        if not root:
            print(f"review-gates: no root comment for {fp[:24]} — skipping",
                  file=sys.stderr)
            continue
        where = f"{item.get('path', '?')}:{item.get('line', '?')}"
        reason = c.strip_mentions(
            c.sanitize_text(item.get("reason") or "", 300))
        body = ASK_TEMPLATE.format(reason=reason, where=where, marker=marker)
        to_post.append((fp, root, body))

    if args.dry_run:
        for fp, root, _ in to_post:
            print(f"review-gates: would ask on {fp[:24]} "
                  f"(in_reply_to {root})")
        print(f"review-gates: dry-run — {len(to_post)} asks planned, "
              f"{len(items) - len(to_post)} already asked/skipped")
        return c.EXIT_OK

    posted = 0
    for fp, root, body in to_post:
        try:
            resp = c.gh_json([
                "api", f"repos/{state['repo']}/pulls/{state['pr']}/comments",
                "-f", f"body={body}", "-F", f"in_reply_to={root}"])
        except (c.GhError, json.JSONDecodeError) as err:
            print(f"review-gates: ask failed for {fp[:24]}: {err}",
                  file=sys.stderr)
            return c.EXIT_FAIL
        append_receipt(out_dir, {
            "kind": "ruling_request_posted", "fingerprint": fp,
            "inReplyTo": root, "commentId": resp.get("id"),
            "headSha": head})
        posted += 1
    print(f"review-gates: posted {posted} ruling asks "
          f"({len(items) - len(to_post)} already asked/skipped)")
    return c.EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
