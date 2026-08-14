# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx>=0.28"]
# ///
"""
pi-bmad-pipeline runner with Linear ticket updates.

Self-supervises pi-bmad-pipeline: spawns the built `bmad-pipeline` supervisor
(from the ~/pi-bmad-pipeline main checkout) against the current project, streams
JSONL events, and mirrors each stage transition as a comment on the Linear
ticket (plus status moves: In Progress → Done / In Review). Reusable across any
story; pass the story id, and optionally a rundef and spec file.

Usage:
    uv run .pi/bmad/scripts/run-pipeline.py STY-112
    uv run .pi/bmad/scripts/run-pipeline.py STY-112 \\
        --rundef create-story-dev-story-code-review-docs \\
        --spec-file .pi/plans/code-stage-type.md
    uv run .pi/bmad/scripts/run-pipeline.py STY-112 --model openrouter/google/gemini-3.7-flash
    uv run .pi/bmad/scripts/run-pipeline.py STY-112 --max-regressions 5

Environment:
    LINEAR_API_KEY   Linear API key (graphql). If unset, runs without Linear updates.
    OBS_SERVER_URL   Observability sink (default http://127.0.0.1:43190).
    OBS_AUTH_TOKEN   Observability bearer (default devtoken).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

# Resolve paths relative to this script so it runs from anywhere.
# <worktree>/.pi/bmad/scripts/run-pipeline.py -> parents[3] == worktree root.
PROJECT_ROOT = Path(__file__).resolve().parents[3]
BMAD_CLI = Path.home() / "pi-bmad-pipeline" / "dist" / "src" / "cli.js"


def _load_env_file(path: Path) -> None:
    """Load KEY=VALUE pairs from a .env file without overriding existing env."""
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


_load_env_file(PROJECT_ROOT / ".env")

# ---------------------------------------------------------------------------
# Linear API
# ---------------------------------------------------------------------------

LINEAR_API_URL = "https://api.linear.app/graphql"
LINEAR_API_KEY = os.environ.get("LINEAR_API_KEY", "")

# issue(id:) accepts the human identifier (e.g. "STY-112") or the UUID.
ISSUE_QUERY = """
query($id: String!) {
  issue(id: $id) { id identifier title team { id key } }
}
"""
COMMENT_MUTATION = """
mutation($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success }
}
"""
STATE_QUERY = """
query($teamId: String!) {
  team(id: $teamId) { states { nodes { id name } } }
}
"""
UPDATE_MUTATION = """
mutation($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success issue { identifier state { name } }
  }
}
"""


def linear_post(query: str, variables: dict) -> dict | None:
    if not LINEAR_API_KEY:
        return None
    try:
        r = httpx.post(
            LINEAR_API_URL,
            headers={"Authorization": LINEAR_API_KEY, "Content-Type": "application/json"},
            json={"query": query, "variables": variables},
            timeout=15,
        )
        return r.json() if r.status_code == 200 else None
    except Exception as exc:
        log(f"⚠️  Linear API error: {exc}")
        return None


def resolve_issue(identifier: str) -> tuple[str, str | None]:
    """Resolve a Linear identifier to (issue_uuid, team_id).

    Falls back to the raw identifier as the issue id if the API is unavailable —
    Linear accepts the identifier wherever an issue id is expected.
    """
    result = linear_post(ISSUE_QUERY, {"id": identifier})
    issue = (result or {}).get("data", {}).get("issue") if result else None
    if issue:
        team_id = (issue.get("team") or {}).get("id")
        log(f"📋 {identifier}: {issue.get('title', '?')} (team {team_id or '?'})")
        return issue["id"], team_id
    log(f"⚠️  Could not resolve {identifier} on Linear — using identifier directly")
    return identifier, None


def post_comment(issue_id: str, body: str) -> None:
    result = linear_post(COMMENT_MUTATION, {"issueId": issue_id, "body": body})
    log("📋 Comment posted" if result else "⚠️  Failed to post comment")


def resolve_state_id(team_id: str, state_name: str) -> str | None:
    result = linear_post(STATE_QUERY, {"teamId": team_id})
    states = (result or {}).get("data", {}).get("team", {}).get("states", {}).get("nodes", []) if result else []
    for state in states:
        if state.get("name", "").lower() == state_name.lower():
            return state["id"]
    return None


def update_status(issue_id: str, team_id: str, state_name: str) -> None:
    state_id = resolve_state_id(team_id, state_name)
    if not state_id:
        log(f"⚠️  Could not resolve state '{state_name}'")
        return
    if linear_post(UPDATE_MUTATION, {"id": issue_id, "stateId": state_id}):
        log(f"📋 Status → '{state_name}'")


# ---------------------------------------------------------------------------
# Logging + state
# ---------------------------------------------------------------------------

def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def format_duration(ms: int | float) -> str:
    secs = int(ms / 1000)
    return f"{secs}s" if secs < 60 else f"{secs // 60}m {secs % 60}s"


def read_state_file(story_id: str) -> dict | None:
    state_path = PROJECT_ROOT / ".pi" / "pipeline" / "state" / f"{story_id}.json"
    if not state_path.exists():
        return None
    try:
        return json.loads(state_path.read_text())
    except Exception:
        return None


def stage_summary(story_id: str, stage_id: str) -> str:
    """One-line decision summary from durable state, or '' if unavailable."""
    state = read_state_file(story_id)
    if not state:
        return ""
    stage_state = state.get("stages", {}).get(stage_id)
    if not stage_state:
        return ""
    return f"```json\n{json.dumps(stage_state, indent=2)}\n```"


# ---------------------------------------------------------------------------
# Event handlers
# ---------------------------------------------------------------------------

def handle_event(ev: dict, story_id: str, issue_id: str, team_id: str | None) -> None:
    event_type = ev.get("event", "")

    if event_type == "run.started":
        rundef = ev.get("rundefId", "?")
        log(f"🚀 Pipeline started: {rundef}")
        post_comment(issue_id, f"🚀 **Pipeline started**\n\n- RunDef: `{rundef}`\n- Story: `{story_id}`\n- Spec: `{ev.get('specFile', '?')}`")
        if team_id:
            update_status(issue_id, team_id, "In Progress")

    elif event_type == "stage.started":
        stage = ev.get("stageId", "?")
        log(f"▶️  Stage {stage} attempt {ev.get('attempt', 1)} started")
        post_comment(issue_id, f"▶️ **Stage `{stage}` started** (attempt {ev.get('attempt', 1)})")

    elif event_type == "stage.finished":
        stage = ev.get("stageId", "?")
        passed = ev.get("passed", False)
        duration = format_duration(ev.get("durationMs", 0))
        icon = "✅" if passed else "❌"
        log(f"{icon} Stage {stage} {'passed' if passed else 'failed'} ({duration})")
        post_comment(issue_id, f"{icon} **Stage `{stage}` {'passed' if passed else 'failed'}** ({duration})\n> {ev.get('reason', '')}")

    elif event_type == "gate.decision":
        gate = ev.get("gate", "?")
        passed = ev.get("passed", False)
        icon = "🟢" if passed else "🔴"
        findings = ev.get("findings", [])
        log(f"{icon} Gate {gate}: {'passed' if passed else 'failed'}")
        body = f"{icon} **Gate `{gate}`** — {ev.get('reason', '')}"
        if findings:
            body += "\n\n**Findings:**\n" + "\n".join(f"- {f}" for f in findings)
        post_comment(issue_id, body)

    elif event_type == "result":
        status = ev.get("status", "?")
        stages_run = ev.get("stagesRun", [])
        regressions = ev.get("regressions", 0)
        duration = format_duration(ev.get("durationMs", 0))
        error = ev.get("error")
        icon = "🎉" if status == "passed" else "⚠️"
        log(f"{icon} Pipeline {status}: {len(stages_run)} stages, {regressions} regressions, {duration}")
        post_comment(
            issue_id,
            f"{icon} **Pipeline {status}**\n\n"
            f"- Stages: {', '.join(f'`{s}`' for s in stages_run)}\n"
            f"- Regressions: {regressions}\n"
            f"- Duration: {duration}"
            + (f"\n- Error: {error}" if error else ""),
        )
        if team_id:
            update_status(issue_id, team_id, "Done" if status == "passed" else "In Review")

    elif event_type == "error":
        log(f"💥 Error: [{ev.get('code', '?')}] {ev.get('message', '?')}")
        post_comment(issue_id, f"💥 **Pipeline error**\n\n- Code: `{ev.get('code', '?')}`\n- Message: {ev.get('message', '?')}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def build_pipeline_command(args: argparse.Namespace) -> list[str]:
    spec_file = args.spec_file or f".pi/artifacts/implementation/stories/{args.story_id.lower()}.md"
    cmd = [
        "node", str(BMAD_CLI), "run", args.rundef,
        "--story-id", args.story_id,
        "--spec-file", spec_file,
        "--max-regressions", str(args.max_regressions),
        "--jsonl",
    ]
    if args.model:
        cmd += ["--model", args.model]
    return cmd


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a pi-bmad-pipeline RunDef with Linear updates")
    parser.add_argument("story_id", help="Linear ticket identifier (e.g. STY-112)")
    parser.add_argument("--rundef", default="create-story-dev-story-code-review-docs",
                        help="RunDef id (default: the reusable create->dev->review<->docs pipeline)")
    parser.add_argument("--spec-file",
                        help="Story/spec file passed to every stage (default: .pi/artifacts/implementation/stories/<story>.md)")
    parser.add_argument("--model", default="openrouter/google/gemini-3.7-flash",
                        help="Model for pipeline stages (default: Gemini 3.7 Flash via OpenRouter)")
    parser.add_argument("--max-regressions", type=int, default=5, help="Max dev↔review regressions before failing (default 5)")
    parser.add_argument("--dry-run", action="store_true", help="Print command without executing")
    args = parser.parse_args()

    if not BMAD_CLI.exists():
        log(f"❌ Supervisor CLI not found: {BMAD_CLI}")
        log("   Build the main checkout:  cd ~/pi-bmad-pipeline && npm run build")
        return 127

    if not LINEAR_API_KEY:
        log("⚠️  LINEAR_API_KEY not set — running without Linear updates")

    issue_id, team_id = (resolve_issue(args.story_id) if LINEAR_API_KEY else (args.story_id, None))

    env = {
        **os.environ,
        "OBS_SERVER_URL": os.environ.get("OBS_SERVER_URL", "http://127.0.0.1:43190"),
        "OBS_AUTH_TOKEN": os.environ.get("OBS_AUTH_TOKEN", "devtoken"),
    }

    cmd = build_pipeline_command(args)
    log(f"🔧 {' '.join(cmd)}")
    log(f"📁 cwd: {PROJECT_ROOT}")

    if args.dry_run:
        log("🏁 Dry run — exiting")
        return 0

    start = time.monotonic()
    proc = subprocess.Popen(cmd, cwd=str(PROJECT_ROOT), stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, text=True, bufsize=1)
    log(f"🏃 Pipeline PID: {proc.pid}")

    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                handle_event(json.loads(line), args.story_id, issue_id, team_id)
            except json.JSONDecodeError:
                log(f"📝 {line}")
    except KeyboardInterrupt:
        log("⏹️  Interrupted — terminating pipeline")
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        return 130

    proc.wait()
    log(f"🏁 Exited code {proc.returncode} in {format_duration((time.monotonic() - start) * 1000)}")

    stderr = proc.stderr.read() if proc.stderr else ""
    if stderr.strip():
        log(f"📝 stderr: {stderr[:500]}")

    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
