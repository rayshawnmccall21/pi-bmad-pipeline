#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""reset_tail.py — return the review tail to pending so a relaunch re-enters
at review-intake.

Mirrors the runner's own reset shape (state-reconcile.ts: status "pending",
startedAt/finishedAt null, attempts and history preserved). Refuses to touch
a running pipeline or one whose dispatch lock is held — this tool is for the
stopped-escalated state only.

Exit: 0 reset · 2 refused (running / locked) · 3 bad input.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REVIEW_STAGES = ("review-sweep", "review-intake", "review-classify",
                 "review-reconcile", "review-approval-retry",
                 "review-approval")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--state-file", required=True)
    ap.add_argument("--stages", default=",".join(REVIEW_STAGES))
    args = ap.parse_args(argv)
    path = Path(args.state_file)
    stages = [s for s in args.stages.split(",") if s]

    if not path.exists():
        print(f"reset-tail: no state file at {path}", file=sys.stderr)
        return 3
    try:
        doc = json.loads(path.read_text())
    except json.JSONDecodeError:
        print("reset-tail: state file is not JSON", file=sys.stderr)
        return 3

    if doc.get("status") == "running":
        print("reset-tail: pipeline status is 'running' — refusing",
              file=sys.stderr)
        return 2
    lock = path.parent.parent / "locks" / str(doc.get("storyId") or "")
    if lock.is_dir() and (lock / "info.json").exists():
        print(f"reset-tail: dispatch lock held at {lock} — refusing",
              file=sys.stderr)
        return 2

    touched = []
    for stage in stages:
        st = (doc.get("stages") or {}).get(stage)
        if not isinstance(st, dict):
            continue
        st["status"] = "pending"
        st["startedAt"] = None
        st["finishedAt"] = None
        touched.append(stage)
    doc["status"] = "pending"
    doc["finishedAt"] = None
    if stages:
        doc["currentStage"] = stages[0]

    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, indent=2) + "\n")
    tmp.replace(path)
    print(f"reset-tail: {len(touched)} stages reset to pending "
          f"({', '.join(touched)}); pipeline pending at {stages[0] if stages else '?'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
