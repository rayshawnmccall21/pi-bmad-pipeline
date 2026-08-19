#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["pyyaml>=6"]
# ///
"""compose_pipeline.py — attach the review tail to the self-driving RunDef.

Deterministically generates two pipeline YAMLs from the base SDLC RunDef:

  sdlc-with-review.yaml   create-story → e2e-plan → dev-story →
                          e2e-verify ⛩ → code-review ⛩ → docs →
                          docs-verify ⛩→docs (coverage of everything
                          changed since origin/main, code-review scoping)
                          → update-pr → review tail (intake → classify →
                          reconcile → approval-retry ⛩→reconcile →
                          approval ⛩→dev-story)

  post-pr-review.yaml     the standalone tail for an already-open PR

Every agent stage gets the observability triple (oPool/oName/oTag) and the
extension set proven by the run that built PR #561 (pi-observability +
pi-subagents + pi-mcp-adapter). Bounded by rounds (--max-regressions)
and per-stage timeouts rather than dollar caps.

The composer is itself a gate: it re-checks id uniqueness and the
onFail-must-be-earlier invariant, then shells out to validate-rundef.mjs
against the built supervisor. Nonzero exit = nothing emitted is trusted.

Exit: 0 both YAMLs emitted and validated · 3 validation failure.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import yaml

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parents[1]

DEFAULT_EXTENSIONS = [
    "/Users/Apple/.pi/agent/extensions/pi-observability/index.ts",
    "/Users/Apple/.pi/agent/npm/node_modules/pi-subagents/index.ts",
    "/Users/Apple/.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts",
]

# Stage-timeout overrides above the base RunDef (strip.yaml precedent:
# dev-story earns 7200s when review-remediation cycles are in play).
TIMEOUT_OVERRIDES = {"dev-story": 7200, "code-review": 2400}

OUT_REL = ".pi/artifacts/review-loop"
FINDINGS_REL = f"{OUT_REL}/findings.json"


def agent_stage(base: dict, story_id: str, extensions: list[str]) -> dict:
    stage = dict(base)
    # Observability triple on EVERY agent stage: pool groups the story,
    # oName is globally unique (story-prefixed) so parallel stories never
    # collide in the pi-observability viewer, oTag filters by stage kind.
    stage["oPool"] = story_id
    stage["oName"] = f"{story_id}-{stage['id']}"
    stage["oTag"] = stage["id"]
    stage["extensions"] = list(extensions)
    timeout = TIMEOUT_OVERRIDES.get(stage["id"])
    if timeout is not None:
        stage["timeout"] = timeout
    # Bounded by rounds (--max-regressions) and per-stage timeouts, not
    # dollars: the operator chose a 10-round ceiling over cost stop-gaps.
    return stage


def code_stage(stage_id: str, script: str, script_args: list[str], *,
               timeout: int, scripts_dir: Path,
               on_fail: str | None = None,
               findings_file: str | None = None) -> dict:
    stage: dict = {
        "id": stage_id,
        "kind": "code",
        "command": "uv",
        "args": ["run", str(scripts_dir / script), *script_args],
        "timeout": timeout,
    }
    if on_fail is not None:
        stage["onFail"] = on_fail
    if findings_file is not None:
        stage["findingsFile"] = findings_file
    return stage


def review_tail(args: argparse.Namespace, scripts_dir: Path, *,
                macro_target: str | None) -> list[dict]:
    pr_repo = ["--pr", str(args.pr), "--repo", args.repo]
    reconcile_args = ["--out", OUT_REL, "--evidence-dir", ".pi/artifacts/validation"]
    reconcile_args.append("--live" if args.live_reconcile else "--dry-run")
    if args.auto_defer_advisory:
        reconcile_args.append("--auto-defer-advisory")
    classify_args = ["--out", OUT_REL,
                     "--blocking-policy", args.blocking_policy]
    if args.product_paths:
        classify_args += ["--product-paths", args.product_paths]
    tail = [
        # FIRST: clear threads whose code no longer exists, so the review
        # requested by intake evaluates a clean slate. The reviewer only
        # emits a verdict while reviewing and counts what is open at that
        # instant — leftovers from earlier heads are why it never approves.
        code_stage("review-sweep", "sweep_stale_threads.py",
                   [*pr_repo, "--out", OUT_REL,
                    "--live" if args.live_reconcile else "--dry-run"],
                   timeout=600, scripts_dir=scripts_dir),
        code_stage("review-intake", "review_intake.py",
                   [*pr_repo, "--out", OUT_REL, "--story-id", args.story_id,
                    "--deadline", "1500"],
                   timeout=2400, scripts_dir=scripts_dir),
        code_stage("review-classify", "classify_findings.py",
                   classify_args, timeout=300, scripts_dir=scripts_dir),
        code_stage("review-reconcile", "reconcile_threads.py",
                   reconcile_args, timeout=900, scripts_dir=scripts_dir),
        code_stage("review-approval-retry", "approval_gate.py",
                   [*pr_repo, "--out", OUT_REL, "--mode", "retry"],
                   timeout=600, scripts_dir=scripts_dir,
                   on_fail="review-reconcile"),
        code_stage("review-approval", "approval_gate.py",
                   [*pr_repo, "--out", OUT_REL, "--mode", "final",
                    "--findings-out", FINDINGS_REL],
                   timeout=1200, scripts_dir=scripts_dir,
                   on_fail=macro_target, findings_file=FINDINGS_REL),
    ]
    if macro_target is None:
        # Standalone tail: no dev-story stage exists, so the final gate's
        # exit 1 is terminal — "needs code work" — by design.
        tail[-1].pop("onFail", None)
    return tail


def compose(args: argparse.Namespace) -> tuple[dict, dict]:
    base_doc = yaml.safe_load(Path(args.base).read_text())
    base_stages = {s["id"]: s for s in base_doc["stages"]}
    required = ["create-story", "e2e-plan", "dev-story", "e2e-verify", "code-review", "docs"]
    missing = [s for s in required if s not in base_stages]
    if missing:
        raise SystemExit(f"base RunDef is missing stages: {missing}")

    scripts_dir = Path(args.scripts_dir)
    extensions = args.extensions

    update_pr = agent_stage({
        "id": "update-pr", "kind": "agent", "workflow": "create-pr",
        "agent": "dev", "thinking": "medium", "timeout": 7200,
    }, args.story_id, extensions)

    docs_verify = code_stage(
        "docs-verify", "verify_docs.py", ["--out", ".pi/artifacts/docs"],
        timeout=300, scripts_dir=scripts_dir, on_fail="docs",
        findings_file=".pi/artifacts/docs/findings.json",
    )
    # Severity-scoped bar: code-review-lenient passes on 0 critical + 0 high
    # (mediums/lows are tracked debt, not blockers). The reviewer stays
    # adversarial; only the gate policy changes.
    base_stages["code-review"] = dict(base_stages["code-review"], gate="code-review-lenient")
    sdlc_stages = (
        [agent_stage(base_stages[s], args.story_id, extensions)
         for s in ["create-story", "e2e-plan", "dev-story", "e2e-verify", "code-review"]]
        + [agent_stage(base_stages["docs"], args.story_id, extensions), docs_verify]
        + [update_pr]
        + review_tail(args, scripts_dir, macro_target="dev-story")
    )
    sdlc = {
        "id": "sdlc-with-review",
        "description": "Self-driving SDLC with the review gate: docs are verified against "
                       "everything changed since origin/main (code-review scoping) BEFORE "
                       "the PR; the PR conversation is a gate; blocking findings regress to dev-story "
                       f"(run with --max-regressions {args.max_regressions}; "
                       "review cycles independently capped at 3 in loop-state.json).",
        "stages": sdlc_stages,
    }

    post_pr = {
        "id": "post-pr-review",
        "description": "Standalone deterministic review tail for an already-open PR. "
                       "reconcile runs --dry-run until flipped; the final gate's "
                       "exit 1 is terminal here (no dev-story stage to regress to).",
        "stages": review_tail(args, scripts_dir, macro_target=None),
    }
    return sdlc, post_pr


def check_invariants(doc: dict) -> None:
    ids: list[str] = [s["id"] for s in doc["stages"]]
    if len(ids) != len(set(ids)):
        raise SystemExit(f"{doc['id']}: duplicate stage ids")
    for index, stage in enumerate(doc["stages"]):
        target = stage.get("onFail")
        if target is not None and (target not in ids or ids.index(target) >= index):
            raise SystemExit(f"{doc['id']}: stage {stage['id']} onFail '{target}' "
                             "is not an earlier stage")
    # Docs must run BEFORE the PR on every path. Because the FSM only moves
    # forward or regresses backward-then-forward, index order is the proof:
    # docs < docs-verify < update-pr guarantees every pass through update-pr
    # (including macro regressions) re-verified docs first.
    if "update-pr" in ids:
        for stage_id in ("docs", "docs-verify"):
            if stage_id not in ids:
                raise SystemExit(f"{doc['id']}: update-pr present without {stage_id} "
                                 "— docs must be verified before the PR")
            if ids.index(stage_id) >= ids.index("update-pr"):
                raise SystemExit(f"{doc['id']}: {stage_id} (index "
                                 f"{ids.index(stage_id)}) must come before "
                                 f"update-pr (index {ids.index('update-pr')})")
        verify = doc["stages"][ids.index("docs-verify")]
        if verify.get("onFail") != "docs":
            raise SystemExit(f"{doc['id']}: docs-verify.onFail must be 'docs'")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--story-id", required=True)
    ap.add_argument("--pr", type=int, required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--base", default=str(REPO_ROOT / ".pi/bmad/pipelines/sdlc.yaml"))
    ap.add_argument("--scripts-dir", default=str(TOOLS_DIR))
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--extensions", nargs="*", default=DEFAULT_EXTENSIONS)
    ap.add_argument("--live-reconcile", action="store_true")
    ap.add_argument("--blocking-policy", choices=["all", "scoped"],
                    default="all",
                    help="scoped: block only on critical / major-in-product / "
                         "security findings; the rest become advisory")
    ap.add_argument("--product-paths", default=None,
                    help="comma-separated product path prefixes (scoped policy)")
    ap.add_argument("--auto-defer-advisory", action="store_true",
                    help="reconcile closes advisory findings on-thread as "
                         "accepted debt so the reviewer's queue can empty")
    ap.add_argument("--max-regressions", type=int, default=10)
    ap.add_argument("--validator",
                    default=str(REPO_ROOT / "skills/pi-bmad-pipeline-workflows/scripts/validate-rundef.mjs"))
    args = ap.parse_args(argv)

    sdlc, post_pr = compose(args)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    emitted: list[Path] = []
    for doc in (sdlc, post_pr):
        check_invariants(doc)
        path = out_dir / f"{doc['id']}.yaml"
        header = ("# GENERATED by compose_pipeline.py — edit the composer, not this file.\n"
                  f"# story={args.story_id} pr={args.pr} repo={args.repo}\n")
        path.write_text(header + yaml.safe_dump(doc, sort_keys=False, width=100))
        emitted.append(path)

    result = subprocess.run(
        ["node", args.validator, *[str(p) for p in emitted]],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(result.stdout + result.stderr, file=sys.stderr)
        print("compose: validate-rundef REJECTED the emitted RunDefs", file=sys.stderr)
        return 3
    for path in emitted:
        print(f"compose: emitted + validated {path}")
    print(f"compose: run with — node <dist>/cli.js run sdlc-with-review "
          f"--story-id {args.story_id} --max-regressions {args.max_regressions}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
