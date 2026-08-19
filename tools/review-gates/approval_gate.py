#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""approval_gate.py — the only exit 0 in the system.

Two modes, two RunDef stages, one static onFail each (the FSM allows one
target per stage, so routing is burned into WHICH gate exits 1):

  --mode retry  (onFail: review-reconcile)
      exit 1 ONLY for deterministic recoverable non-code states:
      verified dispositions that failed to apply (pendingUnapplied).

  --mode final  (onFail: dev-story)
      exit 1 ONLY for blocking findings -> writes findings.json (capped,
      sanitized) and bumps the review-cycle counter.
      exit 0 ONLY when the full evidence conjunction holds for head SHA H.

Escalation (exit 2) covers everything that must never buy a regression:
head drift, cycle budget, fingerprint survival >= 2 rounds, false-positive
volume, needs_human, human-authored threads.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as c  # noqa: E402

FP_VOLUME_ABS = 5
FP_VOLUME_RATIO = 0.30


def checks_green(view: dict) -> bool:
    for item in view.get("statusCheckRollup") or []:
        verdict = item.get("conclusion") or item.get("state")
        if verdict not in {"SUCCESS", "NEUTRAL", "SKIPPED"}:
            return False
    return True


def live_pr(repo: str, pr: int) -> dict:
    raw = c.gh_json(["api", f"repos/{repo}/pulls/{pr}"])
    return {
        "headSha": raw["head"]["sha"],
        "state": raw["state"].upper(),
        "isDraft": bool(raw.get("draft")),
    }


def live_view(repo: str, pr: int) -> dict:
    return c.gh_json(["pr", "view", str(pr), "--repo", repo, "--json",
                      "reviewDecision,statusCheckRollup,mergeable,isDraft"])


def escalate(reason: str) -> int:
    print(f"review-gates: ESCALATE — {reason}", file=sys.stderr)
    return c.EXIT_ESCALATE


def ledger_roots(out_dir: Path) -> dict[str, int]:
    path = out_dir / "ledger.json"
    if not path.exists():
        return {}
    try:
        ledger = json.loads(path.read_text())
        return {t["fingerprint"]: (t.get("commentIds") or [None])[0]
                for t in ledger.get("threads") or []
                if (t.get("commentIds") or [None])[0]}
    except (json.JSONDecodeError, KeyError, TypeError):
        return {}


def write_escalation(out_dir: Path, *, kind: str, head: str, story: str,
                     items: list[dict]) -> None:
    """The machine-readable side of a ruling-eligible escalation — the ask
    list request_rulings/collect_rulings operate on."""
    c.write_json_atomic(out_dir / "escalation.json", {
        "schema": "escalation.v1",
        "kind": kind,
        "generatedAt": c.now_iso(),
        "storyId": story,
        "headSha": head,
        "items": items,
    })


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pr", type=int, required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--mode", choices=["retry", "final"], required=True)
    ap.add_argument("--findings-out", default=None)
    ap.add_argument("--allow-detached", action="store_true")
    ap.add_argument("--approval-poll-attempts", type=int, default=3,
                    help="re-reads of the review decision when zero findings "
                         "block but the reviewer has not approved yet")
    ap.add_argument("--approval-poll-seconds", type=int, default=60)
    args = ap.parse_args(argv)
    out_dir = Path(args.out)

    state = c.loop_state_load(out_dir)
    if not state:
        print("review-gates: no loop-state.json — run review_intake first",
              file=sys.stderr)
        return c.EXIT_FAIL
    try:
        c.preflight_worktree(state, allow_detached=args.allow_detached)
    except SystemExit as err:
        return int(err.code)

    try:
        pr = live_pr(args.repo, args.pr)
    except c.GhError as err:
        print(f"review-gates: PR fetch failed: {err}", file=sys.stderr)
        return c.EXIT_FAIL
    try:
        c.assert_head_matches(state, pr["headSha"])
    except SystemExit as err:
        return int(err.code)

    # ------------------------------------------------------------- retry
    if args.mode == "retry":
        pending = state.get("pendingUnapplied") or []
        if pending:
            print(f"review-gates: {len(pending)} verified dispositions pending "
                  "resolution — regress to reconcile (cheap lane)")
            return c.EXIT_GATE
        return c.EXIT_OK

    # ------------------------------------------------------------- final
    queue_path = out_dir / "queue.json"
    if not queue_path.exists():
        print("review-gates: queue.json missing", file=sys.stderr)
        return c.EXIT_FAIL
    queue = json.loads(queue_path.read_text())
    # Each final evaluation owns escalation.json AND findings.json: a stale
    # artifact from a previous verdict must never drive new ruling requests
    # or send dev-story to re-fix defects it already fixed. (Observed live:
    # a conjunction-branch exit 1 left a 9-hour-old findings file in place
    # and manufactured a redundant regression.)
    findings_path = Path(args.findings_out or out_dir / "findings.json")
    (out_dir / "escalation.json").unlink(missing_ok=True)
    findings_path.unlink(missing_ok=True)

    # The pending human question outranks every other verdict: budget
    # exhaustion must never mask rulings a human still owes the loop.
    plan_path = out_dir / "reconcile-plan.json"
    plan = None
    if plan_path.exists():
        plan = json.loads(plan_path.read_text())
        if plan.get("queueRef") and plan["queueRef"] != c.content_ref(queue_path):
            print("review-gates: reconcile-plan.json is stale relative to "
                  "queue.json — ignoring it (re-run reconcile)", file=sys.stderr)
            plan = None
    if plan and plan["counts"].get("needsHuman"):
        by_fp = {i["fingerprint"]: i for i in queue["blocking"]}
        roots = ledger_roots(out_dir)
        lines = []
        items = []
        for action in plan["actions"]:
            if action.get("action") != "needs_human":
                continue
            fp = action.get("fingerprint", "")
            item = by_fp.get(fp, {})
            where = f"{item.get('path', '?')}:{item.get('line', '?')}"
            reason = (action.get("reason") or "")[:140]
            excerpt = (item.get("excerpt") or "")[:100].replace("\n", " ")
            lines.append(f"  - {fp[:24]} {where} — {reason or excerpt}")
            items.append({
                "fingerprint": fp,
                "path": item.get("path"),
                "line": item.get("line"),
                "reason": reason or excerpt,
                "rootCommentId": roots.get(fp),
            })
        listing = "\n".join(lines[:20])
        write_escalation(out_dir, kind="needs_human",
                         head=queue.get("headSha", ""),
                         story=state.get("storyId", ""), items=items)
        return escalate(
            f"{plan['counts']['needsHuman']} findings dispositioned "
            f"needs_human — human rulings required:\n{listing}\n"
            "Rule each by replying on its PR thread "
            "(/rule fix|false_positive|outdated_fixed|duplicate|defer — "
            "reason; see escalation.json), or edit "
            ".pi/artifacts/review-loop/dispositions.json, then relaunch.")

    cycles = state["reviewCycles"]
    if cycles["count"] >= cycles["max"]:
        return escalate(f"review cycle budget exhausted "
                        f"({cycles['count']}/{cycles['max']})")

    if queue.get("humanThreads"):
        return escalate(f"{len(queue['humanThreads'])} human-authored threads "
                        "— never machine-adjudicated (D8)")

    disp_path = out_dir / "dispositions.json"
    if disp_path.exists():
        disp = json.loads(disp_path.read_text()).get("dispositions", [])
        # The breaker exists to catch a MODEL gaming the loop with FP
        # claims; human-ruled dispositions are the arbiter speaking and
        # count in neither the numerator nor the denominator — ruled
        # entries must not dilute the machine ratio.
        machine = [d for d in disp if not d.get("ruledBy")]
        fp_count = sum(1 for d in machine
                       if d.get("disposition") == "false_positive")
        if machine and (fp_count > FP_VOLUME_ABS
                        or fp_count / max(len(machine), 1) > FP_VOLUME_RATIO):
            return escalate(f"false-positive volume breaker: {fp_count}"
                            f"/{len(machine)} machine dispositions")

    blocking = queue["blocking"]
    if blocking:
        survived = dict(state.get("fingerprints") or {})
        # Survival counts once per reviewed head, not per evaluation —
        # re-running the gate against the same snapshot must not
        # manufacture extra rounds.
        head = queue.get("headSha", "")
        bump = state.get("lastSurvivalHead") != head
        breached = []
        for item in blocking:
            fp = item["fingerprint"]
            rounds = (survived.get(fp) or {}).get("survived", 0)
            if bump:
                rounds += 1
                survived[fp] = {"survived": rounds}
            if rounds >= 2:
                breached.append((fp, rounds, item))
        state["fingerprints"] = survived
        if bump:
            state["lastSurvivalHead"] = head
        state["updatedAt"] = c.now_iso()
        if breached:
            c.loop_state_save(out_dir, state)
            roots = ledger_roots(out_dir)
            items = [{
                "fingerprint": fp,
                "path": item.get("path"),
                "line": item.get("line"),
                "reason": f"survived {rounds} fix-and-review rounds — the "
                          "loop refuses to argue; rule on the thread "
                          "(a fix ruling grants one more round)",
                "rootCommentId": roots.get(fp),
            } for fp, rounds, item in breached]
            write_escalation(out_dir, kind="survival", head=head,
                             story=state.get("storyId", ""), items=items)
            listing = "\n".join(
                f"  - {i['fingerprint'][:24]} {i.get('path', '?')}:"
                f"{i.get('line', '?')}" for i in items[:20])
            return escalate(
                f"{len(breached)} findings survived two fix-and-review "
                f"rounds — the loop refuses to argue:\n{listing}\n"
                "Rule each by replying on its PR thread (/rule …).")
        instruction = {
            "fingerprint": "meta:dispositions",
            "severity": "info",
            "file": None,
            "line": None,
            "text": ("After addressing the findings below, write "
                     ".pi/artifacts/review-loop/dispositions.json "
                     "(schema dispositions.v1) covering EVERY fingerprint with "
                     "one disposition (fix | false_positive | outdated_fixed | "
                     "duplicate | needs_human) and its evidence "
                     "(commitSha + testId for fix; rationale otherwise). "
                     "The reconcile stage verifies evidence before acting."),
        }
        rulings = {}
        rulings_path = out_dir / "rulings.json"
        if rulings_path.exists():
            try:
                rulings = json.loads(
                    rulings_path.read_text()).get("rulings") or {}
            except json.JSONDecodeError:
                rulings = {}

        def finding_text(i: dict) -> str:
            text = f"CodeRabbit [{i['rule']}]: {i['excerpt']}"
            ruling = rulings.get(i["fingerprint"])
            if ruling and ruling.get("verb") == "fix":
                text += ("\nHUMAN RULING (fix): "
                         f"{ruling.get('reason') or 'fix as reviewed'}")
            return text

        c.write_findings_file(findings_path, [instruction] + [
            {"fingerprint": i["fingerprint"], "severity": i["severity"],
             "file": i.get("path"), "line": i.get("line"),
             "text": finding_text(i)}
            for i in blocking
        ])
        state["reviewCycles"]["count"] += 1
        c.loop_state_save(out_dir, state)
        print(f"review-gates: {len(blocking)} blocking findings — regress to "
              f"dev-story (cycle {state['reviewCycles']['count']}"
              f"/{cycles['max']}); findings at {findings_path}")
        return c.EXIT_GATE

    # -------------------------------------------- zero blocking: prove it
    #
    # Nothing here can be repaired by writing code — there are no blocking
    # findings left. A missing reviewer approval is a WAIT, not a
    # regression: the reviewer re-evaluates after threads resolve, so poll
    # briefly, then escalate. Routing this to dev-story would have it
    # rewrite working code and generate a fresh crop of findings.
    conjunction: dict[str, bool] = {}
    for attempt in range(max(1, args.approval_poll_attempts)):
        if attempt:
            time.sleep(args.approval_poll_seconds)
        try:
            view = live_view(args.repo, args.pr)
        except c.GhError as err:
            print(f"review-gates: view fetch failed: {err}", file=sys.stderr)
            return c.EXIT_FAIL
        conjunction = {
            "prOpenNonDraft": pr["state"] == "OPEN" and not pr["isDraft"],
            "reviewDecisionApproved": view.get("reviewDecision") == "APPROVED",
            "checksGreen": checks_green(view),
            "mergeable": view.get("mergeable") in {"MERGEABLE", "UNKNOWN"},
            "zeroBlocking": True,
        }
        if all(conjunction.values()):
            print("review-gates: MERGE-READY — the full evidence conjunction "
                  f"holds for {pr['headSha'][:10]}")
            return c.EXIT_OK
        if [k for k, ok in conjunction.items() if not ok] != \
                ["reviewDecisionApproved"]:
            break  # something other than the pending approval is wrong

    failed = [k for k, ok in conjunction.items() if not ok]
    if failed == ["reviewDecisionApproved"]:
        advisory = len(queue.get("advisory") or [])
        return escalate(
            f"0 blocking findings at {pr['headSha'][:10]}, but the reviewer "
            f"has not approved (decision: {view.get('reviewDecision')!r}). "
            "There is no code work left to do — the loop will not regress "
            f"for this. {advisory} advisory findings were recorded as debt. "
            "Resolve any remaining actionable threads, or approve the PR.")
    print(f"review-gates: conjunction not yet true: {failed}", file=sys.stderr)
    return c.EXIT_FAIL


if __name__ == "__main__":
    raise SystemExit(main())
