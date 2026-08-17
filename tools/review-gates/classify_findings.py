#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""classify_findings.py — deterministic blocking / non-blocking split.

Pure function over ledger.json. No network, no judgment: every rule is a
predicate over API facts, and anything the rules cannot place is BLOCKING
(R9, fail closed). Which comments matter is computed, never guessed.

Exit: 0 queue written · 3 invalid ledger.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as c  # noqa: E402

# Exclusion markers must identify NON-findings only. A severity marker
# always wins: threads carrying one are findings regardless of other
# content ("🧩 Analysis chain" sections are CodeRabbit VERIFYING a real
# finding — the fixture proved excluding them hides Major issues).
COMMAND_ACK_MARKS = ("✅ Actions performed",)
PRAISE_MARKS = ("_🎉", "LGTM!")


def classify_thread(thread: dict) -> tuple[str, str]:
    """Returns (bucket, rule)."""
    author = thread.get("author")
    body = thread.get("excerpt") or ""
    if author != c.BOT_GQL:
        return "human", "R9-unclassifiable"
    if thread["isResolved"]:
        return "nonBlocking", "R4-resolved"
    if thread["isOutdated"]:
        return "nonBlocking", "R5-outdated"
    has_severity = any(mark in body[:200] for mark, _ in c.SEVERITY_MARKS)
    if not has_severity and any(m in body[:120] for m in COMMAND_ACK_MARKS):
        return "excluded", "R7-command-ack"
    if not has_severity and any(m in body[:120] for m in PRAISE_MARKS):
        return "excluded", "R8-praise-info"
    if body:
        return "blocking", "R1-unresolved-thread"
    return "blocking", "R9-unclassifiable"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True,
                    help="dir containing ledger.json; queue.json is written here")
    args = ap.parse_args(argv)
    out_dir = Path(args.out)
    ledger_path = out_dir / "ledger.json"
    if not ledger_path.exists():
        print("review-gates: ledger.json missing — run review_intake first",
              file=sys.stderr)
        return c.EXIT_FAIL
    try:
        ledger = json.loads(ledger_path.read_text())
        assert ledger["schema"] == "review-ledger.v1"
    except (json.JSONDecodeError, KeyError, AssertionError):
        print("review-gates: ledger.json is not review-ledger.v1", file=sys.stderr)
        return c.EXIT_FAIL

    blocking: list[dict] = []
    non_blocking: list[dict] = []
    excluded: list[dict] = []
    human: list[dict] = []

    for thread in ledger["threads"]:
        bucket, rule = classify_thread(thread)
        item = {"fingerprint": thread["fingerprint"], "rule": rule}
        if bucket == "blocking":
            item.update({
                "kind": "thread",
                "severity": c.parse_severity(thread.get("excerpt") or ""),
                "path": thread.get("path"),
                "line": thread.get("line"),
                "excerpt": (thread.get("excerpt") or "")[:400],
            })
            blocking.append(item)
        elif bucket == "nonBlocking":
            non_blocking.append(item)
        elif bucket == "human":
            human.append({**item, "author": thread.get("author")})
        else:
            excluded.append(item)

    for od in ledger["outsideDiff"]:
        blocking.append({
            "fingerprint": od["fingerprint"],
            "rule": "R2-outside-diff",
            "kind": "outside-diff",
            "severity": c.parse_severity(od.get("excerpt") or ""),
            "path": od.get("file"),
            "line": od.get("lines"),
            "excerpt": (od.get("excerpt") or "")[:400],
        })

    everything = [i["fingerprint"] for i in blocking + non_blocking + excluded + human]
    if len(everything) != len(set(everything)):
        print("review-gates: fingerprint collision in partition", file=sys.stderr)
        return c.EXIT_FAIL
    expected = len(ledger["threads"]) + len(ledger["outsideDiff"])
    if len(everything) != expected:
        print(f"review-gates: partition incomplete {len(everything)}/{expected}",
              file=sys.stderr)
        return c.EXIT_FAIL

    queue = {
        "schema": "review-queue.v1",
        "generatedAt": c.now_iso(),
        "ledgerRef": c.content_ref(ledger_path),
        "headSha": ledger["pr"]["headSha"],
        "blocking": blocking,
        "nonBlocking": non_blocking,
        "excluded": excluded,
        "humanThreads": human,
        "meta": {
            "advertisedActionable": ledger["review"].get("advertisedActionable"),
            "reviewState": ledger["review"]["state"],
        },
    }
    c.write_json_atomic(out_dir / "queue.json", queue)
    print(f"review-gates: queue written — {len(blocking)} blocking, "
          f"{len(non_blocking)} non-blocking, {len(excluded)} excluded, "
          f"{len(human)} human")
    return c.EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
