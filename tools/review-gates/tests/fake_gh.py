#!/usr/bin/env python3
"""Fake `gh` binary for tests. Routes by argv against the fixture dir in
RG_FIXDIR. Mirrors the exact call shapes the scripts use — a new call shape
here means the seam changed and tests must acknowledge it."""

import json
import os
import sys
from pathlib import Path

FIX = Path(os.environ["RG_FIXDIR"])
args = sys.argv[1:]
joined = " ".join(args)


def out(obj) -> None:
    sys.stdout.write(obj if isinstance(obj, str) else json.dumps(obj))
    sys.exit(0)


def load(name: str):
    return json.loads((FIX / name).read_text())


def record(name: str, obj) -> None:
    with open(FIX / name, "a") as fh:
        fh.write(json.dumps(obj) + "\n")


# --- ruling-loop seams (must precede the generic handlers) -------------------

if args[:2] == ["api", "graphql"] and "resolveReviewThread" in joined:
    thread_id = next((a.split("=", 1)[1] for a in args if a.startswith("t=")), "")
    record("resolved.jsonl", {"threadId": thread_id})
    out({"data": {"resolveReviewThread":
                  {"thread": {"id": thread_id, "isResolved": True}}}})

if args[:2] == ["api", "graphql"] and "nodes(ids:" in joined:
    ids = [a.split("=", 1)[1] for a in args if a.startswith("ids[]=")]
    table = load("node-threads.json")
    nodes = []
    for i in ids:
        t = table.get(i)
        if t is None:
            nodes.append(None)
            continue
        comments = t.get("comments", [])
        nodes.append({
            "id": i,
            "isResolved": t.get("isResolved", False),
            "isOutdated": t.get("isOutdated", False),
            "resolvedBy": t.get("resolvedBy"),
            "comments": {"totalCount": len(comments), "nodes": comments},
        })
    out({"data": {"rateLimit": {"cost": 1, "remaining": 4999}, "nodes": nodes}})

if (args[:1] == ["api"] and len(args) > 1 and "/pulls/" in args[1]
        and args[1].endswith("/comments")
        and any(a.startswith("body=") for a in args)):
    body = next(a[5:] for a in args if a.startswith("body="))
    reply_to = next((a.split("=", 1)[1] for a in args
                     if a.startswith("in_reply_to=")), None)
    prior = FIX / "posted-comments.jsonl"
    n = sum(1 for _ in prior.open()) if prior.exists() else 0
    record("posted-comments.jsonl", {"body": body, "in_reply_to": reply_to})
    out({"id": 990000 + n, "body": body})

if args[:2] == ["pr", "comment"]:
    record("pr-comments.jsonl", {"args": args})
    out("")

if args[:1] == ["api"] and len(args) > 1 and args[1].startswith("users/"):
    out(load("ruler.json"))

if args[:1] == ["api"] and "graphql" in args:
    # reviewThreads page — single page from fixture, GraphQL node shape.
    data = load("threads.json")
    nodes = [
        {
            "id": t["id"],
            "isResolved": t["isResolved"],
            "isOutdated": t["isOutdated"],
            "path": t["path"],
            "line": t["line"],
            "comments": {"nodes": [
                {"databaseId": c["databaseId"],
                 "author": {"login": c["author"]},
                 "body": c["body"]} for c in t["comments"]]},
        }
        for t in data["threads"]
    ]
    out({"data": {"repository": {"pullRequest": {"reviewThreads": {
        "pageInfo": {"hasNextPage": False, "endCursor": None},
        "nodes": nodes}}}}})

if args[:1] == ["api"] and "/reviews/" in joined:
    meta = load("latest-review-meta.json")
    out({"id": meta["id"], "state": meta["state"], "commit_id": meta["commit_id"],
         "submitted_at": meta["submitted_at"],
         "user": {"login": "coderabbitai[bot]"},
         "body": (FIX / "latest-review-body.md").read_text()})

if args[:1] == ["api"] and joined.endswith("/reviews") or ("/reviews" in joined and "--paginate" in joined):
    reviews = load("reviews.json")
    rest = [
        {"id": r["id"], "state": r["state"], "commit_id": r["commit_id"],
         "submitted_at": r["submitted_at"], "user": {"login":
            "coderabbitai[bot]" if r["user"] == "coderabbitai[bot]" else r["user"]},
         "body": r["body_head"]}
        for r in reviews
    ]
    out([rest] if "--slurp" in args else rest)

if args[:1] == ["api"] and "/pulls/" in joined:
    out(load("pr.json"))

if args[:2] == ["pr", "view"]:
    out(load("view.json"))

sys.stderr.write(f"fake_gh: unhandled args: {args}\n")
sys.exit(64)
