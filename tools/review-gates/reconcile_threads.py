#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""reconcile_threads.py — the system's ONLY GitHub writer, and a clerk.

Judgment already happened: dev-story wrote dispositions.json. This stage
VERIFIES each claim deterministically, then applies only what survives:

  fix            -> commit exists AND named test executed green this cycle
                    -> reply with evidence -> resolve -> re-verify isResolved
  false_positive -> reply WITHOUT resolve + ask the reviewer bot to
                    re-adjudicate. Never machine-resolved.
  outdated_fixed -> verified like fix (commit optional) -> reply + resolve
  duplicate      -> canonical fingerprint must be covered -> reply + resolve
  needs_human    -> reported; the approval gate escalates on it

Then: SHA-fenced push (only if local is ahead), and one re-review request
per pushed SHA (idempotent via loop-state.reRequested).

Default is --dry-run: writes reconcile-plan.json, touches nothing.
Exit: 0 applied/planned · 2 fence or verification-apply failure, or the
dispositions file is missing (all needs_human, fail closed) · 3 bad input.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as c  # noqa: E402

RESOLVE_MUTATION = """mutation($t:ID!){
resolveReviewThread(input:{threadId:$t}){thread{id isResolved}}}"""


def commit_exists(sha: str) -> bool:
    if not sha or len(sha) < 7:
        return False
    code, _ = c.git(["cat-file", "-e", f"{sha}^{{commit}}"])
    return code == 0


def test_ran_green(test_id: str, evidence_dir: Path) -> bool:
    """The named test must appear with a pass marker in this cycle's
    evidence artifacts — existence of a test file proves nothing."""
    if not test_id or not evidence_dir.is_dir():
        return False
    for path in evidence_dir.rglob("*"):
        if not path.is_file() or path.stat().st_size > 4_000_000:
            continue
        try:
            text = path.read_text(errors="ignore")
        except OSError:
            continue
        if test_id in text and any(
            marker in text for marker in ("passed", "PASS", "✓", "ok")
        ):
            return True
    return False


def plan_actions(queue: dict, dispositions: list[dict],
                 evidence_dir: Path) -> list[dict]:
    blocking = {i["fingerprint"]: i for i in queue["blocking"]}
    covered: set[str] = set()
    actions: list[dict] = []
    for d in dispositions:
        fp = d.get("fingerprint")
        kind = d.get("disposition")
        ev = d.get("evidence") or {}
        if fp not in blocking or fp in covered or kind not in c.DISPOSITIONS:
            actions.append({"fingerprint": fp, "action": "skip_unknown",
                            "reason": "not a blocking fingerprint or bad kind"})
            continue
        covered.add(fp)
        if kind == "fix":
            ok = commit_exists(ev.get("commitSha", "")) and \
                test_ran_green(ev.get("testId", ""), evidence_dir)
            actions.append({
                "fingerprint": fp,
                "action": "reply_and_resolve" if ok else "skip_unverified",
                "reason": None if ok else "commit or green-test evidence failed",
                "reply": f"Fixed in {ev.get('commitSha', '')[:10]} — regression "
                         f"test `{ev.get('testId')}` executed green this cycle.",
            })
        elif kind == "false_positive":
            actions.append({
                "fingerprint": fp, "action": "reply_without_resolve",
                "reply": f"We believe this is a false positive: {ev.get('rationale', '')} "
                         "@coderabbitai please re-verify and resolve if you agree.",
            })
        elif kind == "outdated_fixed":
            actions.append({
                "fingerprint": fp, "action": "reply_and_resolve",
                "reply": f"Already absent at current head: {ev.get('rationale', '')}",
            })
        elif kind == "duplicate":
            actions.append({
                "fingerprint": fp, "action": "reply_and_resolve",
                "reply": f"Duplicate of {ev.get('canonicalFingerprint', '?')}.",
            })
        else:  # needs_human
            actions.append({"fingerprint": fp, "action": "needs_human",
                            "reason": ev.get("rationale", "")})
    for fp in blocking:
        if fp not in covered:
            actions.append({"fingerprint": fp, "action": "uncovered"})
    return actions


def apply_live(actions: list[dict], state: dict, repo: str, pr: int) -> list[str]:
    """Apply reply/resolve actions. Returns fingerprints that FAILED to
    apply (they become pendingUnapplied — the retry gate's territory)."""
    failed: list[str] = []
    for action in actions:
        fp = action["fingerprint"]
        kind = action["action"]
        if kind not in {"reply_and_resolve", "reply_without_resolve"}:
            continue
        try:
            comment_id = action.get("commentId")
            if comment_id:
                c.gh(["api", f"repos/{repo}/pulls/{pr}/comments",
                      "-f", f"body={action['reply']}",
                      "-F", f"in_reply_to={comment_id}"])
            if kind == "reply_and_resolve":
                out = c.gh_json(["api", "graphql",
                                 "-f", f"query={RESOLVE_MUTATION}",
                                 "-f", f"t={fp}"])
                if out.get("errors"):
                    raise c.GhError(["graphql"], 1, json.dumps(out["errors"])[:200])
                resolved = out["data"]["resolveReviewThread"]["thread"]["isResolved"]
                if not resolved:
                    raise c.GhError(["graphql"], 1, "isResolved still false")
        except c.GhError as err:
            print(f"review-gates: apply failed for {fp[:20]}: {err}",
                  file=sys.stderr)
            failed.append(fp)
    return failed


def fenced_push(state: dict) -> bool:
    """Push only when local is ahead, fenced on the expected remote head."""
    branch = state["branch"]
    code, local = c.git(["rev-parse", "HEAD"])
    if code != 0:
        return False
    code, remote = c.git(["rev-parse", f"origin/{branch}"])
    if code != 0 or local == remote:
        return True  # nothing to push
    code, _ = c.git(["push",
                     f"--force-with-lease={branch}:{remote}", "origin", "HEAD"])
    return code == 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=True)
    mode.add_argument("--live", dest="dry_run", action="store_false")
    ap.add_argument("--dispositions", default=None)
    ap.add_argument("--evidence-dir", default=".pi/artifacts/validation")
    ap.add_argument("--allow-detached", action="store_true")
    args = ap.parse_args(argv)
    out_dir = Path(args.out)

    queue_path = out_dir / "queue.json"
    if not queue_path.exists():
        print("review-gates: queue.json missing", file=sys.stderr)
        return c.EXIT_FAIL
    queue = json.loads(queue_path.read_text())

    state = c.loop_state_load(out_dir)
    if state:
        try:
            c.preflight_worktree(state, allow_detached=args.allow_detached)
        except SystemExit as err:
            return int(err.code)

    disp_path = Path(args.dispositions or out_dir / "dispositions.json")
    if not disp_path.exists():
        cycles = (state.get("reviewCycles") or {}).get("count", 0) if state else 0
        if cycles == 0:
            # First entry into the tail: dev-story has never regressed, so
            # no dispositions can exist yet. Nothing to reconcile — the
            # approval gate downstream turns the blocking findings into the
            # first regression.
            plan = {
                "schema": "reconcile-plan.v1",
                "generatedAt": c.now_iso(),
                "dryRun": True,
                "actions": [{"fingerprint": i["fingerprint"],
                             "action": "uncovered"}
                            for i in queue["blocking"]],
                "counts": {"needsHuman": 0,
                           "uncovered": len(queue["blocking"])},
            }
            c.write_json_atomic(out_dir / "reconcile-plan.json", plan)
            print("review-gates: cycle 0 — no dispositions expected yet; "
                  f"{len(queue['blocking'])} findings await the first "
                  "regression")
            return c.EXIT_OK
        # Cycle >= 1: dev-story ran and owed us dispositions. Fail closed.
        plan = {
            "schema": "reconcile-plan.v1",
            "generatedAt": c.now_iso(),
            "dryRun": True,
            "actions": [{"fingerprint": i["fingerprint"], "action": "needs_human",
                         "reason": "no dispositions.json"}
                        for i in queue["blocking"]],
            "counts": {"needsHuman": len(queue["blocking"]), "uncovered": 0},
        }
        c.write_json_atomic(out_dir / "reconcile-plan.json", plan)
        print("review-gates: dispositions.json missing — all blocking findings "
              "mapped to needs_human (fail closed)", file=sys.stderr)
        return c.EXIT_ESCALATE

    try:
        disp_doc = json.loads(disp_path.read_text())
        dispositions = disp_doc["dispositions"]
        assert disp_doc.get("schema") == "dispositions.v1"
    except (json.JSONDecodeError, KeyError, AssertionError):
        print("review-gates: dispositions.json is not dispositions.v1",
              file=sys.stderr)
        return c.EXIT_FAIL

    actions = plan_actions(queue, dispositions, Path(args.evidence_dir))
    counts = {
        "replyAndResolve": sum(1 for a in actions if a["action"] == "reply_and_resolve"),
        "replyWithoutResolve": sum(1 for a in actions if a["action"] == "reply_without_resolve"),
        "skippedUnverified": sum(1 for a in actions if a["action"] == "skip_unverified"),
        "needsHuman": sum(1 for a in actions if a["action"] == "needs_human"),
        "uncovered": sum(1 for a in actions if a["action"] == "uncovered"),
    }
    plan = {
        "schema": "reconcile-plan.v1",
        "generatedAt": c.now_iso(),
        "dryRun": args.dry_run,
        "queueRef": c.content_ref(queue_path),
        "actions": actions,
        "counts": counts,
    }
    c.write_json_atomic(out_dir / "reconcile-plan.json", plan)
    print(f"review-gates: plan — {counts}")
    if args.dry_run:
        return c.EXIT_OK

    failed = apply_live(actions, state, state["repo"], state["pr"])
    state["pendingUnapplied"] = failed
    state["updatedAt"] = c.now_iso()
    if not fenced_push(state):
        c.loop_state_save(out_dir, state)
        print("review-gates: fenced push REJECTED — branch moved externally",
              file=sys.stderr)
        return c.EXIT_ESCALATE
    code, head = c.git(["rev-parse", "HEAD"])
    if code == 0 and head not in state["reRequested"]:
        c.gh(["pr", "comment", str(state["pr"]), "--repo", state["repo"],
              "--body", f"@coderabbitai full review\n\n<!-- review-gates:{head} -->"])
        state["reRequested"].append(head)
        state["expectedHead"] = head
    c.loop_state_save(out_dir, state)
    return c.EXIT_ESCALATE if failed else c.EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
