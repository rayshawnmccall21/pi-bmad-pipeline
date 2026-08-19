#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""sweep_stale_threads.py — clear dead threads before a review is requested.

The reviewer decides a PR's verdict only while it runs a review, counting
what is open at that instant. Threads left over from earlier heads stay
open, so the review of a new head never sees a clean slate and the reviewer
never emits an approval. This stage runs FIRST in the review tail and
resolves the threads whose code no longer exists (unresolved AND outdated),
so the review that follows starts clean.

Scope, deliberately narrow:
  - unresolved AND outdated  -> reply + resolve
  - unresolved and LIVE      -> untouched (a real finding; the gate's job)
  - already resolved         -> untouched
  - thread rooted by a human -> untouched (D8)

The reply claims nothing: it states the referenced code is gone, not that
the finding was fixed or wrong.

Default is --dry-run. Exit: 0 swept/nothing to do · 2 apply failure · 3 bad
input.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as c  # noqa: E402

THREADS_QUERY = """query($o:String!,$r:String!,$p:Int!,$c:String){
repository(owner:$o,name:$r){pullRequest(number:$p){
reviewThreads(first:100,after:$c){pageInfo{hasNextPage endCursor}
nodes{id isResolved isOutdated path line
comments(first:20){nodes{databaseId author{login} body}}}}}}}"""

RESOLVE_MUTATION = """mutation($t:ID!){
resolveReviewThread(input:{threadId:$t}){thread{id isResolved}}}"""

SWEEP_REPLY = (
    "Outdated — the code this comment referred to no longer exists at the "
    "current head, so the thread cannot be acted on as written.\n\n"
    "Resolving it so the next review starts from a clean slate. This is "
    "**not** a claim that the finding was fixed or that it was incorrect; "
    "if it still applies to the current code it will be raised again."
)


def fetch_threads(repo: str, pr: int) -> list[dict]:
    owner, name = repo.split("/")
    threads: list[dict] = []
    cursor: str | None = None
    while True:
        args = ["api", "graphql", "-f", f"query={THREADS_QUERY}",
                "-f", f"o={owner}", "-f", f"r={name}", "-F", f"p={pr}"]
        if cursor:
            args += ["-f", f"c={cursor}"]
        data = c.gh_json(args)
        block = data["data"]["repository"]["pullRequest"]["reviewThreads"]
        threads.extend(block["nodes"])
        if not block["pageInfo"]["hasNextPage"]:
            return threads
        cursor = block["pageInfo"]["endCursor"]
        if cursor is None:
            c.die(c.EXIT_FAIL, "pagination: hasNextPage without endCursor")


def is_sweepable(node: dict) -> bool:
    if node.get("isResolved") or not node.get("isOutdated"):
        return False
    comments = (node.get("comments") or {}).get("nodes") or []
    if not comments:
        return False
    author = (comments[0].get("author") or {}).get("login")
    return author == c.BOT_GQL           # D8: human-rooted threads are ours
                                         # to read, never to adjudicate


def append_receipt(out_dir: Path, receipt: dict) -> None:
    with (out_dir / "ruling-receipts.jsonl").open("a") as fh:
        fh.write(json.dumps({"at": c.now_iso(), **receipt}) + "\n")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pr", type=int, required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", required=True)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=True)
    mode.add_argument("--live", dest="dry_run", action="store_false")
    ap.add_argument("--allow-detached", action="store_true")
    args = ap.parse_args(argv)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    state = c.loop_state_load(out_dir)
    if state:
        try:
            c.preflight_worktree(state, allow_detached=args.allow_detached)
        except SystemExit as err:
            return int(err.code)

    try:
        nodes = fetch_threads(args.repo, args.pr)
    except c.GhError as err:
        print(f"review-gates: thread fetch failed: {err}", file=sys.stderr)
        return c.EXIT_FAIL

    stale = [n for n in nodes if is_sweepable(n)]
    live = sum(1 for n in nodes
               if not n.get("isResolved") and not n.get("isOutdated"))
    if not stale:
        print(f"review-gates: nothing stale to sweep "
              f"({len(nodes)} threads, {live} live unresolved)")
        return c.EXIT_OK

    if args.dry_run:
        print(f"review-gates: dry-run — would sweep {len(stale)} outdated "
              f"unresolved threads ({live} live unresolved left intact)")
        for n in stale[:10]:
            print(f"   {n['id'][:24]} {n.get('path')}:{n.get('line')}")
        return c.EXIT_OK

    failed: list[str] = []
    for node in stale:
        tid = node["id"]
        root = ((node.get("comments") or {}).get("nodes") or [{}])[0]
        root_id = root.get("databaseId")
        try:
            if root_id:
                c.gh(["api", f"repos/{args.repo}/pulls/{args.pr}/comments",
                      "-f", f"body={SWEEP_REPLY}",
                      "-F", f"in_reply_to={root_id}"])
            out = c.gh_json(["api", "graphql",
                             "-f", f"query={RESOLVE_MUTATION}",
                             "-f", f"t={tid}"])
            if out.get("errors"):
                raise c.GhError(["graphql"], 1, json.dumps(out["errors"])[:200])
            if not out["data"]["resolveReviewThread"]["thread"]["isResolved"]:
                raise c.GhError(["graphql"], 1, "isResolved still false")
            append_receipt(out_dir, {
                "kind": "stale_thread_swept", "fingerprint": tid,
                "path": node.get("path"), "line": node.get("line"),
                "inReplyTo": root_id})
        except c.GhError as err:
            print(f"review-gates: sweep failed for {tid[:20]}: {err}",
                  file=sys.stderr)
            failed.append(tid)

    print(f"review-gates: swept {len(stale) - len(failed)}/{len(stale)} "
          f"outdated threads ({live} live unresolved left for the gate)")
    return c.EXIT_ESCALATE if failed else c.EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
