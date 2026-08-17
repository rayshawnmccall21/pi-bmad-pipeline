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
