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


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pr", type=int, required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--mode", choices=["retry", "final"], required=True)
    ap.add_argument("--findings-out", default=None)
    ap.add_argument("--allow-detached", action="store_true")
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

    cycles = state["reviewCycles"]
    if cycles["count"] >= cycles["max"]:
        return escalate(f"review cycle budget exhausted "
                        f"({cycles['count']}/{cycles['max']})")

    if queue.get("humanThreads"):
        return escalate(f"{len(queue['humanThreads'])} human-authored threads "
                        "— never machine-adjudicated (D8)")

    plan_path = out_dir / "reconcile-plan.json"
    if plan_path.exists():
        plan = json.loads(plan_path.read_text())
        if plan["counts"].get("needsHuman"):
            return escalate(f"{plan['counts']['needsHuman']} findings "
                            "dispositioned needs_human")

    disp_path = out_dir / "dispositions.json"
    if disp_path.exists():
        disp = json.loads(disp_path.read_text()).get("dispositions", [])
        fp_count = sum(1 for d in disp if d.get("disposition") == "false_positive")
        if disp and (fp_count > FP_VOLUME_ABS
                     or fp_count / max(len(disp), 1) > FP_VOLUME_RATIO):
            return escalate(f"false-positive volume breaker: {fp_count}"
                            f"/{len(disp)} dispositions")

    blocking = queue["blocking"]
    if blocking:
        survived = dict(state.get("fingerprints") or {})
        breached = []
        for item in blocking:
            fp = item["fingerprint"]
            rounds = (survived.get(fp) or {}).get("survived", 0) + 1
            survived[fp] = {"survived": rounds}
            if rounds >= 2:
                breached.append(fp)
        state["fingerprints"] = survived
        state["updatedAt"] = c.now_iso()
        if breached:
            c.loop_state_save(out_dir, state)
            return escalate(f"{len(breached)} findings survived two "
                            "fix-and-review rounds — the loop refuses to argue")
        findings_path = Path(args.findings_out or out_dir / "findings.json")
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
        c.write_findings_file(findings_path, [instruction] + [
            {"fingerprint": i["fingerprint"], "severity": i["severity"],
             "file": i.get("path"), "line": i.get("line"),
             "text": f"CodeRabbit [{i['rule']}]: {i['excerpt']}"}
            for i in blocking
        ])
        state["reviewCycles"]["count"] += 1
        c.loop_state_save(out_dir, state)
        print(f"review-gates: {len(blocking)} blocking findings — regress to "
              f"dev-story (cycle {state['reviewCycles']['count']}"
              f"/{cycles['max']}); findings at {findings_path}")
        return c.EXIT_GATE

    # -------------------------------------------- zero blocking: prove it
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
    failed = [k for k, ok in conjunction.items() if not ok]
    if failed:
        print(f"review-gates: conjunction not yet true: {failed}",
              file=sys.stderr)
        return c.EXIT_GATE if "reviewDecisionApproved" in failed else c.EXIT_FAIL

    print("review-gates: MERGE-READY — the full evidence conjunction holds "
          f"for {pr['headSha'][:10]}")
    return c.EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
