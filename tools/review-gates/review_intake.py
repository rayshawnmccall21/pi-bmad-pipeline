#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""review_intake.py — poll for a completed head-SHA review, then snapshot.

Stage 1 of the review tail. Absence of a review NEVER passes: "no review
yet" and "reviewed clean" are different states, so this stage blocks until
a CodeRabbit review exists whose commit_id equals the live PR head, then
writes ledger.json (review-ledger.v1) from a fully paginated snapshot.

Exit: 0 ledger written · 2 poll timeout / head drift · 3 collection failure.
"""

from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as c  # noqa: E402

GRAPHQL_THREADS = """query($o:String!,$r:String!,$p:Int!,$c:String){
repository(owner:$o,name:$r){pullRequest(number:$p){
reviewThreads(first:100,after:$c){pageInfo{hasNextPage endCursor}
nodes{id isResolved isOutdated path line
comments(first:20){nodes{databaseId author{login} body}}}}}}}"""

OUTSIDE_SUMMARY = re.compile(
    r"Outside diff range comments \((\d+)\)", re.IGNORECASE
)
OUTSIDE_FILE = re.compile(r"<summary>([^<(]+?)\s*\(\d+\)</summary>")
ACTIONABLE = re.compile(r"\*\*Actionable comments posted: (\d+)\*\*")


def fetch_pr(repo: str, pr: int) -> dict:
    raw = c.gh_json(["api", f"repos/{repo}/pulls/{pr}"])
    return {
        "repo": repo,
        "number": pr,
        "headSha": raw["head"]["sha"],
        "branch": raw["head"]["ref"],
        "state": raw["state"].upper(),
        "isDraft": bool(raw.get("draft")),
        "mergeableState": raw.get("mergeable_state"),
    }


def fetch_reviews(repo: str, pr: int) -> list[dict]:
    pages = c.gh_json(
        ["api", "--paginate", f"repos/{repo}/pulls/{pr}/reviews", "--slurp"]
    )
    reviews = [r for page in pages for r in page]
    return [r for r in reviews if r["user"]["login"] == c.BOT_REST]


def latest_head_review(reviews: list[dict], head: str) -> dict | None:
    on_head = [
        r for r in reviews
        if r["commit_id"] == head
        and r["state"] in {"APPROVED", "CHANGES_REQUESTED", "COMMENTED"}
    ]
    if not on_head:
        return None
    return max(on_head, key=lambda r: r.get("submitted_at") or "")


def fetch_threads(repo: str, pr: int) -> tuple[list[dict], int]:
    owner, name = repo.split("/")
    threads: list[dict] = []
    cursor: str | None = None
    pages = 0
    while True:
        args = ["api", "graphql", "-f", f"query={GRAPHQL_THREADS}",
                "-f", f"o={owner}", "-f", f"r={name}", "-F", f"p={pr}"]
        if cursor:
            args += ["-f", f"c={cursor}"]
        data = c.gh_json(args)
        block = data["data"]["repository"]["pullRequest"]["reviewThreads"]
        pages += 1
        for node in block["nodes"]:
            comments = node["comments"]["nodes"]
            first = comments[0] if comments else {}
            threads.append({
                "fingerprint": node["id"],
                "isResolved": node["isResolved"],
                "isOutdated": node["isOutdated"],
                "path": node["path"],
                "line": node["line"],
                "author": (first.get("author") or {}).get("login"),
                "excerpt": c.sanitize_text(first.get("body") or "", 400),
                "commentIds": [x["databaseId"] for x in comments],
            })
        if not block["pageInfo"]["hasNextPage"]:
            return threads, pages
        cursor = block["pageInfo"]["endCursor"]
        if cursor is None:
            c.die(c.EXIT_FAIL, "pagination: hasNextPage without endCursor")


def parse_outside_diff(body: str, review_id: int) -> list[dict]:
    """Fail-closed parse of the observed-convention section. Advertised
    count and extracted count must agree, or we escalate (parser drift)."""
    summary = OUTSIDE_SUMMARY.search(body)
    if not summary:
        return []
    advertised = int(summary.group(1))
    section = body[summary.end():]
    entries: list[dict] = []
    for m in re.finditer(
        r"<summary>([^<(]+?)\s*\(\d+\)</summary>(.*?)(?=<summary>|\Z)",
        section, re.DOTALL,
    ):
        file_name = m.group(1).strip().lstrip("> ").strip()
        chunk = m.group(2)
        for lines_m in re.finditer(r"`(\d+(?:-\d+)?)`:\s*(.{0,400})", chunk):
            text = c.sanitize_text(lines_m.group(2), 400)
            entries.append({
                "fingerprint": "od:" + c.sha256(file_name + text[:200])[:20],
                "reviewId": review_id,
                "file": file_name,
                "lines": lines_m.group(1),
                "excerpt": text,
            })
    if len(entries) != advertised:
        c.die(c.EXIT_ESCALATE,
              f"outside-diff parser drift: advertised {advertised}, "
              f"extracted {len(entries)} — refusing to guess")
    return entries


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pr", type=int, required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--story-id", default="unknown")
    ap.add_argument("--deadline", type=int, default=1500)
    ap.add_argument("--poll-interval", type=int, default=20)
    ap.add_argument("--max-polls", type=int, default=0,
                    help="0 = until deadline; N = at most N polls (tests)")
    ap.add_argument("--allow-detached", action="store_true")
    ap.add_argument("--no-request-review", dest="request_review",
                    action="store_false", default=True)
    args = ap.parse_args(argv)
    out_dir = Path(args.out)

    try:
        pr = fetch_pr(args.repo, args.pr)
    except c.GhError as err:
        print(f"review-gates: PR fetch failed: {err}", file=sys.stderr)
        return c.EXIT_FAIL

    state = c.loop_state_load(out_dir)
    if not state:
        state = c.loop_state_init(
            out_dir, story_id=args.story_id, pr=args.pr, repo=args.repo,
            branch=pr["branch"], head=pr["headSha"],
        )
    try:
        c.preflight_worktree(state, allow_detached=args.allow_detached)
    except SystemExit as err:
        return int(err.code)
    expected = state.get("expectedHead")
    if expected and pr["headSha"] != expected:
        if c.local_head() == pr["headSha"]:
            # The pipeline's own push (update-pr / reconcile) moved the PR
            # head and the local checkout carries it: adopt the new head.
            state["expectedHead"] = pr["headSha"]
            state["updatedAt"] = c.now_iso()
            c.loop_state_save(out_dir, state)
            state = c.loop_state_load(out_dir)
        else:
            print("review-gates: head drift — PR head "
                  f"{pr['headSha'][:10]} is neither expected "
                  f"{expected[:10]} nor the local HEAD; external "
                  "interference, escalating", file=sys.stderr)
            return c.EXIT_ESCALATE

    if pr["state"] != "OPEN" or pr["isDraft"]:
        print(f"review-gates: PR is {pr['state']}, draft={pr['isDraft']}",
              file=sys.stderr)
        return c.EXIT_ESCALATE

    # ---- poll: a completed bot review whose commit_id == live head -------
    deadline = time.monotonic() + args.deadline
    polls = 0
    while True:
        polls += 1
        try:
            reviews = fetch_reviews(args.repo, args.pr)
        except c.GhError as err:
            print(f"review-gates: reviews fetch failed: {err}", file=sys.stderr)
            return c.EXIT_FAIL
        review = latest_head_review(reviews, pr["headSha"])
        if review:
            break
        # Auto-reviews pause after 5 reviewed commits; the loop is immune
        # only if it asks. Once per SHA, idempotent via loop-state.
        if (args.request_review and pr["headSha"] not in state["reRequested"]):
            try:
                c.gh(["pr", "comment", str(args.pr), "--repo", args.repo,
                      "--body", "@coderabbitai full review\n\n"
                      f"<!-- review-gates:{pr['headSha']} -->"])
                state["reRequested"].append(pr["headSha"])
                state["updatedAt"] = c.now_iso()
                c.loop_state_save(out_dir, state)
                state = c.loop_state_load(out_dir)
                print("review-gates: requested @coderabbitai full review "
                      f"for {pr['headSha'][:10]}")
            except c.GhError as err:
                print(f"review-gates: re-review request failed: {err}",
                      file=sys.stderr)
                return c.EXIT_FAIL
        if args.max_polls and polls >= args.max_polls:
            print("review-gates: no head-SHA review within max-polls",
                  file=sys.stderr)
            return c.EXIT_ESCALATE
        if time.monotonic() >= deadline:
            print("review-gates: no head-SHA review before deadline",
                  file=sys.stderr)
            return c.EXIT_ESCALATE
        time.sleep(args.poll_interval)

    # ---- snapshot --------------------------------------------------------
    try:
        full_review = c.gh_json(
            ["api", f"repos/{args.repo}/pulls/{args.pr}/reviews/{review['id']}"]
        )
        threads, pages = fetch_threads(args.repo, args.pr)
        pr_after = fetch_pr(args.repo, args.pr)
    except c.GhError as err:
        print(f"review-gates: snapshot failed: {err}", file=sys.stderr)
        return c.EXIT_FAIL

    if pr_after["headSha"] != pr["headSha"]:
        print("review-gates: head moved during collection", file=sys.stderr)
        return c.EXIT_ESCALATE

    body = full_review.get("body") or ""
    advertised = ACTIONABLE.search(body)
    try:
        outside = parse_outside_diff(body, review["id"])
    except SystemExit as err:
        return int(err.code)

    ledger = {
        "schema": "review-ledger.v1",
        "generatedAt": c.now_iso(),
        "storyId": state.get("storyId", args.story_id),
        "pr": pr,
        "review": {
            "id": review["id"],
            "state": review["state"],
            "commitId": review["commit_id"],
            "submittedAt": review.get("submitted_at"),
            "matchesHead": review["commit_id"] == pr["headSha"],
            "advertisedActionable":
                int(advertised.group(1)) if advertised else None,
        },
        "threads": threads,
        "outsideDiff": outside,
        "counts": {
            "threads": len(threads),
            "unresolved": sum(1 for t in threads if not t["isResolved"]),
            "outsideDiff": len(outside),
            "pages": pages,
        },
    }
    c.write_json_atomic(out_dir / "ledger.json", ledger)

    state["updatedAt"] = c.now_iso()
    c.loop_state_save(out_dir, state)
    print(f"review-gates: ledger written — {ledger['counts']['unresolved']}"
          f"/{ledger['counts']['threads']} unresolved, "
          f"{len(outside)} outside-diff, review {review['state']} on head")
    return c.EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
