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


AUTO_DEFER_REPLY = (
    "Recorded as accepted debt by the review policy — this finding has **not "
    "been fixed** and has not been judged incorrect.\n\n"
    "It falls below the merge-blocking bar for this repository "
    "({reason}). Blocking is scoped to critical defects, major defects in "
    "product code, and anything in the security category; everything else "
    "is tracked as debt rather than gating the merge.\n\n"
    "Reopen this thread or reply `/rule fix — <instruction>` if you want it "
    "addressed in this PR."
)


def plan_auto_defer(queue: dict, covered: set[str],
                    roots: dict[str, int]) -> list[dict]:
    """Close advisory findings on-thread as accepted debt.

    Deliberately honest: the reply claims neither a fix nor a false
    positive, so the audit trail says exactly what happened. Findings the
    human already ruled are skipped — a ruling outranks the policy."""
    actions = []
    for item in queue.get("advisory") or []:
        fp = item["fingerprint"]
        if fp in covered or not fp.startswith("PRRT_"):
            continue
        entry = {
            "fingerprint": fp,
            "action": "auto_defer",
            "reason": item.get("advisoryReason", "below the blocking bar"),
            "reply": AUTO_DEFER_REPLY.format(
                reason=item.get("advisoryReason", "below the blocking bar")),
        }
        if roots.get(fp):
            entry["commentId"] = roots[fp]
        actions.append(entry)
    return actions


def plan_actions(queue: dict, dispositions: list[dict], evidence_dir: Path,
                 root_comments: dict[str, int] | None = None) -> list[dict]:
    blocking = {i["fingerprint"]: i for i in queue["blocking"]}
    # A disposition is honoured for any finding the reviewer raised, not just
    # the blocking subset — the owner may rule on an advisory finding, and a
    # ruling always outranks the policy that demoted it.
    adjudicable = dict(blocking)
    adjudicable.update({i["fingerprint"]: i
                        for i in queue.get("advisory") or []})
    roots = root_comments or {}
    covered: set[str] = set()
    actions: list[dict] = []

    # Fingerprints a machine `duplicate` may point at: already non-blocking,
    # closed by a verified claim in this batch, or closed by a human ruling.
    # Without this check, dispositioning everything `duplicate` of a bogus
    # canonical would resolve every thread with zero evidence.
    non_blocking_fps = {i["fingerprint"]
                        for i in queue.get("nonBlocking") or []}
    verified_closers: set[str] = set()
    for d in dispositions:
        dfp, dkind = d.get("fingerprint"), d.get("disposition")
        dev = d.get("evidence") or {}
        if d.get("ruledBy") and dkind in ("false_positive", "outdated_fixed",
                                          "duplicate", "defer"):
            verified_closers.add(dfp)
        elif dkind == "fix" and commit_exists(dev.get("commitSha", "")) \
                and test_ran_green(dev.get("testId", ""), evidence_dir):
            verified_closers.add(dfp)
        elif dkind == "outdated_fixed" and (
                test_ran_green(dev.get("testId", ""), evidence_dir)
                or commit_exists(dev.get("commitSha", ""))):
            verified_closers.add(dfp)

    def act(fp: str, **fields) -> None:
        entry = {"fingerprint": fp, **fields}
        if "reply" in entry and roots.get(fp):
            entry["commentId"] = roots[fp]
        actions.append(entry)

    for d in dispositions:
        fp = d.get("fingerprint")
        kind = d.get("disposition")
        ev = d.get("evidence") or {}
        ruled = d.get("ruledBy")
        if fp not in adjudicable or fp in covered or kind not in c.DISPOSITIONS:
            actions.append({"fingerprint": fp, "action": "skip_unknown",
                            "reason": "not a blocking fingerprint or bad kind"})
            continue
        covered.add(fp)
        if kind == "fix":
            ok = commit_exists(ev.get("commitSha", "")) and \
                test_ran_green(ev.get("testId", ""), evidence_dir)
            act(fp,
                action="reply_and_resolve" if ok else "skip_unverified",
                reason=None if ok else "commit or green-test evidence failed",
                reply=f"Fixed in {ev.get('commitSha', '')[:10]} — regression "
                      f"test `{ev.get('testId')}` executed green this cycle.")
        elif kind == "false_positive":
            if ruled:
                # The owner is the final arbiter: a human FP ruling closes
                # the thread; only machine FPs stay open for the bot.
                act(fp, action="reply_and_resolve",
                    reply="Human ruling: false positive — "
                          f"{ev.get('rationale', '')}")
            else:
                act(fp, action="reply_without_resolve",
                    reply="We believe this is a false positive: "
                          f"{ev.get('rationale', '')} "
                          "@coderabbitai please re-verify and resolve "
                          "if you agree.")
        elif kind == "outdated_fixed":
            if ruled:
                act(fp, action="reply_and_resolve",
                    reply="Human ruling: outdated/fixed — "
                          f"{ev.get('rationale', '')}")
            else:
                ok = test_ran_green(ev.get("testId", ""), evidence_dir) \
                    or commit_exists(ev.get("commitSha", ""))
                act(fp,
                    action="reply_and_resolve" if ok else "skip_unverified",
                    reason=None if ok else "outdated_fixed needs a green "
                                          "testId or commitSha evidence",
                    reply=f"Already absent at current head: "
                          f"{ev.get('rationale', '')}")
        elif kind == "duplicate":
            canon = ev.get("canonicalFingerprint", "")
            if ruled:
                act(fp, action="reply_and_resolve",
                    reply="Human ruling: duplicate of "
                          f"{canon or ev.get('rationale', '?')}.")
            else:
                ok = bool(canon) and (canon in non_blocking_fps
                                      or canon in verified_closers)
                act(fp,
                    action="reply_and_resolve" if ok else "skip_unverified",
                    reason=None if ok else "duplicate canonical is not a "
                                          "covered or resolved fingerprint",
                    reply=f"Duplicate of {canon or '?'}.")
        elif kind == "defer":
            if ruled:
                act(fp, action="reply_and_resolve",
                    reply="Human ruling: deferred — "
                          f"{ev.get('rationale', '')} (recorded as debt).")
            else:
                # defer is human-only; a model shelving its homework is a
                # human question, not a resolution.
                actions.append({"fingerprint": fp, "action": "needs_human",
                                "reason": "defer is a human-only disposition"})
        else:  # needs_human
            actions.append({"fingerprint": fp, "action": "needs_human",
                            "reason": ev.get("rationale", "")})
    for fp in blocking:
        if fp not in covered:
            actions.append({"fingerprint": fp, "action": "uncovered"})
    return actions


def apply_live(actions: list[dict], state: dict, repo: str, pr: int,
               head: str = "") -> list[str]:
    """Apply reply/resolve actions. Returns fingerprints that FAILED to
    apply (they become pendingUnapplied — the retry gate's territory).

    Replies carry an idempotence marker keyed by (fingerprint, reviewed
    head): a retry after a partial failure re-verifies resolution but never
    posts the same reply twice. The reviewed head (queue.headSha) is used —
    NOT expectedHead, which the re-request step advances after a push."""
    actionable = [a for a in actions
                  if a["action"] in {"reply_and_resolve",
                                     "reply_without_resolve", "auto_defer"}]
    already_replied: set[str] = set()
    with_root = [a for a in actionable if a.get("commentId")]
    if with_root:
        try:
            nodes = c.fetch_thread_nodes([a["fingerprint"] for a in with_root])
        except c.GhError as err:
            print(f"review-gates: reply precheck failed ({err}) — "
                  "failing closed, no replies this pass", file=sys.stderr)
            return [a["fingerprint"] for a in actionable]
        for a in with_root:
            marker = c.reply_marker(a["fingerprint"], head, a["reply"])
            comments = c.thread_comments(nodes.get(a["fingerprint"]) or {})
            if any(marker in (cm.get("body") or "") for cm in comments):
                already_replied.add(a["fingerprint"])

    failed: list[str] = []
    for action in actionable:
        fp = action["fingerprint"]
        kind = action["action"]
        comment_id = action.get("commentId")
        if not comment_id:
            # No known root comment: refusing to resolve (or FP-reply)
            # without the on-thread evidence text is the fail-closed side
            # of reply-then-resolve.
            print(f"review-gates: no root comment known for {fp[:20]} — "
                  "refusing to act without a reply", file=sys.stderr)
            failed.append(fp)
            continue
        try:
            if fp not in already_replied:
                body = (f"{action['reply']}\n\n"
                        f"{c.reply_marker(fp, head, action['reply'])}")
                c.gh(["api", f"repos/{repo}/pulls/{pr}/comments",
                      "-f", f"body={body}",
                      "-F", f"in_reply_to={comment_id}"])
            if kind in {"reply_and_resolve", "auto_defer"}:
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
    ap.add_argument("--auto-defer-advisory", action="store_true",
                    help="close advisory findings on-thread as accepted debt "
                         "(off by default: machine-resolving threads is "
                         "opt-in)")
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

    roots: dict[str, int] = {}
    ledger_path = out_dir / "ledger.json"
    if ledger_path.exists():
        try:
            ledger = json.loads(ledger_path.read_text())
            roots = {t["fingerprint"]: (t.get("commentIds") or [None])[0]
                     for t in ledger.get("threads") or []
                     if (t.get("commentIds") or [None])[0]}
        except (json.JSONDecodeError, KeyError, TypeError):
            roots = {}

    disp_path = Path(args.dispositions or out_dir / "dispositions.json")
    if not disp_path.exists():
        cycles = (state.get("reviewCycles") or {}).get("count", 0) if state else 0
        # Advisory findings are policy-determined, not disposition-determined:
        # they are cleared on every pass, including the cycle-0 one.
        defers = (plan_auto_defer(queue, set(), roots)
                  if args.auto_defer_advisory else [])
        if cycles == 0:
            # First entry into the tail: dev-story has never regressed, so
            # no dispositions can exist yet. Nothing to reconcile — the
            # approval gate downstream turns the blocking findings into the
            # first regression.
            plan = {
                "schema": "reconcile-plan.v1",
                "generatedAt": c.now_iso(),
                "dryRun": args.dry_run,
                "queueRef": c.content_ref(queue_path),
                "actions": [{"fingerprint": i["fingerprint"],
                             "action": "uncovered"}
                            for i in queue["blocking"]] + defers,
                "counts": {"needsHuman": 0,
                           "uncovered": len(queue["blocking"]),
                           "autoDeferred": len(defers)},
            }
            c.write_json_atomic(out_dir / "reconcile-plan.json", plan)
            print("review-gates: cycle 0 — no dispositions expected yet; "
                  f"{len(queue['blocking'])} findings await the first "
                  f"regression ({len(defers)} advisory auto-deferred)")
            if args.dry_run or not defers:
                return c.EXIT_OK
            failed = apply_live(defers, state, state["repo"], state["pr"],
                                head=queue.get("headSha", ""))
            state["pendingUnapplied"] = failed
            state["updatedAt"] = c.now_iso()
            c.loop_state_save(out_dir, state)
            return c.EXIT_ESCALATE if failed else c.EXIT_OK
        # Cycle >= 1: dev-story ran and owed us dispositions. Fail closed.
        plan = {
            "schema": "reconcile-plan.v1",
            "generatedAt": c.now_iso(),
            "dryRun": True,
            "actions": [{"fingerprint": i["fingerprint"], "action": "needs_human",
                         "reason": "no dispositions.json"}
                        for i in queue["blocking"]] + defers,
            "counts": {"needsHuman": len(queue["blocking"]), "uncovered": 0,
                       "autoDeferred": len(defers)},
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

    actions = plan_actions(queue, dispositions, Path(args.evidence_dir), roots)
    if args.auto_defer_advisory:
        # A human ruling outranks the policy: never auto-defer a finding the
        # owner already dispositioned.
        ruled = {a["fingerprint"] for a in actions
                 if a["action"] != "uncovered"}
        actions += plan_auto_defer(queue, ruled, roots)
    counts = {
        "replyAndResolve": sum(1 for a in actions if a["action"] == "reply_and_resolve"),
        "replyWithoutResolve": sum(1 for a in actions if a["action"] == "reply_without_resolve"),
        "skippedUnverified": sum(1 for a in actions if a["action"] == "skip_unverified"),
        "needsHuman": sum(1 for a in actions if a["action"] == "needs_human"),
        "uncovered": sum(1 for a in actions if a["action"] == "uncovered"),
        "autoDeferred": sum(1 for a in actions if a["action"] == "auto_defer"),
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

    failed = apply_live(actions, state, state["repo"], state["pr"],
                        head=queue.get("headSha", ""))
    state["pendingUnapplied"] = failed
    state["updatedAt"] = c.now_iso()
    if not fenced_push(state):
        c.loop_state_save(out_dir, state)
        print("review-gates: fenced push REJECTED — branch moved externally",
              file=sys.stderr)
        return c.EXIT_ESCALATE
    code, head = c.git(["rev-parse", "HEAD"])
    if code == 0 and head not in state["reRequested"]:
        try:
            c.gh(["pr", "comment", str(state["pr"]), "--repo", state["repo"],
                  "--body",
                  f"@coderabbitai review\n\n<!-- review-gates:{head} -->"])
            state["reRequested"].append(head)
            state["expectedHead"] = head
        except c.GhError as err:
            # Persist what already happened (pendingUnapplied, reRequested)
            # before surfacing the failure — an uncaught error here would
            # lose the ledger of applied writes AND repeat this comment.
            print(f"review-gates: re-review request failed: {err}",
                  file=sys.stderr)
            c.loop_state_save(out_dir, state)
            return c.EXIT_ESCALATE
    c.loop_state_save(out_dir, state)
    return c.EXIT_ESCALATE if failed else c.EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
