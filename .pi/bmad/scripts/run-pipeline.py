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
story; pass the story id and optionally a pipeline ID or repository pipeline YAML.
The story specification is derived separately from the canonical story path.

Usage:
    uv run .pi/bmad/scripts/run-pipeline.py STY-112
    uv run .pi/bmad/scripts/run-pipeline.py STY-112 \\
        --pipeline .pi/bmad/pipelines/dev-review-loop.yaml
    uv run .pi/bmad/scripts/run-pipeline.py STY-112 --pipeline dev-review-loop
    uv run .pi/bmad/scripts/run-pipeline.py STY-112 --model openai-codex/gpt-5.6-sol
    uv run .pi/bmad/scripts/run-pipeline.py STY-112 --max-regressions 5

Environment:
    LINEAR_API_KEY   Linear API key (graphql). If unset, runs without Linear updates.
    OBS_SERVER_URL   Observability sink (default http://127.0.0.1:43190).
    OBS_AUTH_TOKEN   Observability bearer (default devtoken).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import httpx

# Resolve either the project adapter or packaged template to its repository root.
SCRIPT_PATH = Path(__file__).resolve()
PROJECT_ROOT = (
    SCRIPT_PATH.parents[1]
    if SCRIPT_PATH.parent.name == "tools"
    else SCRIPT_PATH.parents[3]
)
BMAD_CLI = Path.home() / "pi-bmad-pipeline" / "dist" / "src" / "cli.js"
CREATE_STORY_RUNDEF = "create-story-dev-story-code-review-docs"
PARENT_MODEL = "openai-codex/gpt-5.6-sol"
PIPELINE_DIRECTORY = Path(".pi") / "bmad" / "pipelines"
PIPELINE_ID_PATTERN = re.compile(r"[a-z][a-z0-9-]*")
STORY_ID_PATTERN = re.compile(r"[A-Z]+-[1-9][0-9]*")
TOP_LEVEL_PIPELINE_ID_PATTERN = re.compile(r"id:\s*([a-z][a-z0-9-]*)\s*(?:#.*)?")
STORY_SOURCE_INTAKE_PATH = (
    Path(".pi") / "artifacts" / "implementation" / "story-source-intake.md"
)
STORY_SOURCE_HEADING = "# Story Source Intake"
UPSTREAM_SOURCE_HEADING = "## Upstream Source"
STORY_ID_PREFIX = "- Story ID:"
SOURCE_KIND_PREFIX = "- Source Kind:"
STORY_TITLE_PREFIX = "- Title:"
ISSUE_IDENTIFIER_PREFIX = "- Issue Identifier:"
ISSUE_URL_PREFIX = "- Issue URL:"
LEGACY_LINEAR_METADATA_FIELDS = (
    ("issue_identifier", ISSUE_IDENTIFIER_PREFIX),
    ("title", STORY_TITLE_PREFIX),
)
CANONICAL_LINEAR_METADATA_FIELDS = (
    ("story_id", STORY_ID_PREFIX),
    ("source_kind", SOURCE_KIND_PREFIX),
    ("title", STORY_TITLE_PREFIX),
    ("issue_identifier", ISSUE_IDENTIFIER_PREFIX),
    ("issue_url", ISSUE_URL_PREFIX),
)
KNOWN_METADATA_FIELDS = dict(LEGACY_LINEAR_METADATA_FIELDS + CANONICAL_LINEAR_METADATA_FIELDS)


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


def response_object(result: dict | None, *path: str, mutation: bool = False) -> dict | None:
    if not isinstance(result, dict) or result.get("errors"):
        return None
    value = result.get("data")
    if not isinstance(value, dict):
        return None
    for key in path:
        value = value.get(key)
        if not isinstance(value, dict):
            return None
    if mutation and value.get("success") is not True:
        return None
    return value


def resolve_issue(identifier: str) -> tuple[str, str | None]:
    """Resolve a Linear identifier to (issue_uuid, team_id).

    Falls back to the raw identifier as the issue id if the API is unavailable —
    Linear accepts the identifier wherever an issue id is expected.
    """
    result = linear_post(ISSUE_QUERY, {"id": identifier})
    issue = response_object(result, "issue")
    if issue:
        issue_id = issue.get("id")
        team = issue.get("team")
        if (
            isinstance(issue_id, str)
            and issue.get("identifier") == identifier
            and (team is None or isinstance(team, dict))
        ):
            team_id = team.get("id") if team else None
            if team_id is None or isinstance(team_id, str):
                log(f"📋 {identifier}: {issue.get('title', '?')} (team {team_id or '?'})")
                return issue_id, team_id
    log(f"⚠️  Could not resolve {identifier} on Linear — using identifier directly")
    return identifier, None


def post_comment(issue_id: str, body: str) -> None:
    result = linear_post(COMMENT_MUTATION, {"issueId": issue_id, "body": body})
    created = response_object(result, "commentCreate", mutation=True)
    log("📋 Comment posted" if created else "⚠️  Failed to post comment")


def resolve_state_id(team_id: str, state_name: str) -> str | None:
    result = linear_post(STATE_QUERY, {"teamId": team_id})
    states = response_object(result, "team", "states")
    nodes = states.get("nodes") if states else None
    if not isinstance(nodes, list) or any(
        not isinstance(state, dict)
        or not isinstance(state.get("id"), str)
        or not isinstance(state.get("name"), str)
        for state in nodes
    ):
        return None
    for state in nodes:
        if state["name"].lower() == state_name.lower():
            return state["id"]
    return None


def update_status(issue_id: str, team_id: str, state_name: str) -> None:
    state_id = resolve_state_id(team_id, state_name)
    if not state_id:
        log(f"⚠️  Could not resolve state '{state_name}'")
        return
    result = linear_post(UPDATE_MUTATION, {"id": issue_id, "stateId": state_id})
    if response_object(result, "issueUpdate", mutation=True):
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

# Max safe integer that JSON numbers round-trip losslessly (IEEE-754 double).
MAX_SAFE_INTEGER = 2**53 - 1

# Bounds for allowlisted JSON event strings and lists. Oversized values are
# TRUNCATED before validation and side effects (review R1-2): rejecting the
# whole event would silently drop the Linear mirror of a real gate failure
# (the supervisor legitimately emits findings up to 2048 chars).
EVENT_MAX_STRING_LENGTH = 1000
EVENT_MAX_LIST_COUNT = 1000
EVENT_MAX_RAW_LINE_BYTES = 1_000_000
DIAGNOSTIC_PREFIX = "📝 "


def bounded_diagnostic(line: str) -> str:
    """One terminal diagnostic bounded to 500 chars including the prefix."""
    return f"{DIAGNOSTIC_PREFIX}{line[:500 - len(DIAGNOSTIC_PREFIX)]}"


def _bounded_event_value(value: object) -> object:
    """Recursively truncate event containers so side effects stay bounded."""
    if isinstance(value, str):
        return value[:EVENT_MAX_STRING_LENGTH]
    if isinstance(value, list):
        return [_bounded_event_value(item) for item in value[:EVENT_MAX_LIST_COUNT]]
    if isinstance(value, dict):
        return {key: _bounded_event_value(item) for key, item in value.items()}
    return value


def bound_event(event: dict) -> dict:
    """Bound every value of a decoded event before validation and handling."""
    return {key: _bounded_event_value(value) for key, value in event.items()}


def is_attempt(value: object) -> bool:
    """Exact int (not bool), 1..MAX_SAFE_INTEGER."""
    return type(value) is int and 1 <= value <= MAX_SAFE_INTEGER


def is_duration(value: object) -> bool:
    """Exact int/float (not bool), finite, 0..MAX_SAFE_INTEGER."""
    if type(value) is int:
        # Bound the int directly so huge decoded integers never reach the float-only finite check.
        return 0 <= value <= MAX_SAFE_INTEGER
    if type(value) is float:
        return math.isfinite(value) and 0 <= value <= MAX_SAFE_INTEGER
    return False


def is_regressions(value: object) -> bool:
    """Exact int (not bool), 0..MAX_SAFE_INTEGER."""
    return type(value) is int and 0 <= value <= MAX_SAFE_INTEGER


def valid_event(event: object) -> bool:
    if not isinstance(event, dict) or not isinstance(event.get("event"), str):
        return False

    is_string = lambda value: (
        isinstance(value, str) and len(value) <= EVENT_MAX_STRING_LENGTH
    )
    is_boolean = lambda value: isinstance(value, bool)
    is_string_list = lambda value: (
        isinstance(value, list)
        and len(value) <= EVENT_MAX_LIST_COUNT
        and all(is_string(item) for item in value)
    )
    event_type = event["event"]
    allowed_keys = {
        "run.started": {"event", "ts", "storyId", "rundefId", "specFile"},
        "stage.started": {"event", "ts", "storyId", "stageId", "attempt"},
        "stage.finished": {
            "event",
            "ts",
            "storyId",
            "stageId",
            "attempt",
            "kind",
            "passed",
            "exitCode",
            "durationMs",
            "reason",
        },
        "gate.decision": {
            "event",
            "ts",
            "storyId",
            "stageId",
            "gate",
            "passed",
            "reason",
            "findings",
        },
        "budget.decision": {
            "event",
            "ts",
            "storyId",
            "scope",
            "stageId",
            "withinBudget",
            "reason",
        },
        "progress": {"event", "ts", "storyId", "message"},
        "result": {
            "event",
            "ts",
            "storyId",
            "status",
            "stagesRun",
            "regressions",
            "durationMs",
            "error",
        },
        "error": {"event", "ts", "storyId", "code", "message"},
    }
    if not event.keys() <= allowed_keys.get(event_type, set()):
        return False

    validators = {
        "run.started": lambda: is_string(event.get("rundefId"))
        and is_string(event.get("specFile")),
        "stage.started": lambda: is_string(event.get("stageId"))
        and is_attempt(event.get("attempt")),
        "stage.finished": lambda: is_string(event.get("stageId"))
        and is_boolean(event.get("passed"))
        and is_duration(event.get("durationMs"))
        and is_string(event.get("reason")),
        "gate.decision": lambda: is_string(event.get("gate"))
        and is_boolean(event.get("passed"))
        and is_string(event.get("reason"))
        and is_string_list(event.get("findings")),
        "budget.decision": lambda: event.get("scope") in ("stage", "run")
        and ("stageId" not in event or is_string(event["stageId"]))
        and is_boolean(event.get("withinBudget"))
        and is_string(event.get("reason")),
        "progress": lambda: is_string(event.get("message")),
        "result": lambda: event.get("status")
        in ("passed", "failed", "needs-approval", "paused", "needs-attention")
        and is_string_list(event.get("stagesRun"))
        and is_regressions(event.get("regressions"))
        and is_duration(event.get("durationMs"))
        and ("error" not in event or is_string(event["error"])),
        "error": lambda: is_string(event.get("code"))
        and is_string(event.get("message")),
    }
    validator = validators.get(event_type)
    return validator() if validator else False


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
        if team_id and status != "passed":
            update_status(issue_id, team_id, "In Review")

    elif event_type == "error":
        log(f"💥 Error: [{ev.get('code', '?')}] {ev.get('message', '?')}")
        post_comment(issue_id, f"💥 **Pipeline error**\n\n- Code: `{ev.get('code', '?')}`\n- Message: {ev.get('message', '?')}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _parse_story_source_metadata(lines: list[str]) -> list[tuple[str, str]]:
    """Parse one closed, ordered metadata block without accepting lookalikes."""
    entries: list[tuple[str, str]] = []
    for line in lines:
        if not line.strip():
            continue
        matched = False
        for field, prefix in KNOWN_METADATA_FIELDS.items():
            if line == prefix or line.startswith(f"{prefix} "):
                entries.append((field, line.removeprefix(prefix).strip()))
                matched = True
                break
        if not matched:
            raise ValueError(
                f"{STORY_SOURCE_INTAKE_PATH} contains a noncanonical metadata line"
            )
    return entries


def _metadata_values(
    entries: list[tuple[str, str]],
    schema: tuple[tuple[str, str], ...],
) -> dict[str, str] | None:
    """Return values only when names, order, uniqueness, and blanks match schema."""
    expected_fields = tuple(field for field, _prefix in schema)
    if tuple(field for field, _value in entries) != expected_fields:
        return None
    values = dict(entries)
    if any(not value for value in values.values()):
        return None
    return values


def _is_linear_issue_url(value: str, story_id: str) -> bool:
    """Bind a canonical HTTPS Linear issue URL to one exact story identifier."""
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    path_parts = tuple(part for part in parsed.path.split("/") if part)
    issue_offsets = [index for index, part in enumerate(path_parts) if part == "issue"]
    return (
        parsed.scheme == "https"
        and parsed.netloc == "linear.app"
        and not parsed.query
        and not parsed.fragment
        and len(issue_offsets) == 1
        and issue_offsets[0] + 1 < len(path_parts)
        and path_parts[issue_offsets[0] + 1] == story_id
    )


def _validate_linear_metadata(story_id: str, entries: list[tuple[str, str]]) -> None:
    """Accept the legacy pair or pi-bmad's canonical Linear source metadata."""
    values = _metadata_values(entries, LEGACY_LINEAR_METADATA_FIELDS)
    if values is None:
        values = _metadata_values(entries, CANONICAL_LINEAR_METADATA_FIELDS)
        if values is None:
            raise ValueError(
                f"{STORY_SOURCE_INTAKE_PATH} metadata does not match an accepted schema"
            )
        if values["source_kind"] != "linear-issue":
            raise ValueError(
                f"{STORY_SOURCE_INTAKE_PATH} canonical source kind must be linear-issue"
            )
        if values["story_id"] != story_id:
            raise ValueError(
                f"story identity mismatch: intake is '{values['story_id'][:100]}', "
                f"dispatch is '{story_id[:100]}'"
            )
        if not _is_linear_issue_url(values["issue_url"], story_id):
            raise ValueError(
                f"{STORY_SOURCE_INTAKE_PATH} issue URL does not match the dispatched story"
            )

    intake_story_id = values["issue_identifier"]
    if intake_story_id != story_id:
        raise ValueError(
            f"story identity mismatch: intake is '{intake_story_id[:100]}', "
            f"dispatch is '{story_id[:100]}'"
        )


def validate_story_source_intake(story_id: str, rundef: str) -> None:
    """Reject malformed or mismatched intake for the local create-story pipeline."""
    if rundef != CREATE_STORY_RUNDEF:
        return

    if _contains_symlink(STORY_SOURCE_INTAKE_PATH):
        raise ValueError(f"{STORY_SOURCE_INTAKE_PATH} path must not contain symlinks")
    source_intake_path = PROJECT_ROOT / STORY_SOURCE_INTAKE_PATH
    try:
        intake_lines = source_intake_path.read_text().splitlines()
    except (OSError, UnicodeError) as exc:
        raise ValueError(
            f"cannot read {STORY_SOURCE_INTAKE_PATH}: {type(exc).__name__}"
        ) from None

    if intake_lines.count(STORY_SOURCE_HEADING) != 1:
        raise ValueError(f"{STORY_SOURCE_INTAKE_PATH} requires one canonical heading")
    if intake_lines.count(UPSTREAM_SOURCE_HEADING) != 1:
        raise ValueError(f"{STORY_SOURCE_INTAKE_PATH} requires one upstream-source heading")

    section_start = intake_lines.index(STORY_SOURCE_HEADING)
    section_end = intake_lines.index(UPSTREAM_SOURCE_HEADING)
    if section_start >= section_end:
        raise ValueError(f"{STORY_SOURCE_INTAKE_PATH} has invalid section order")

    entries = _parse_story_source_metadata(intake_lines[section_start + 1 : section_end])
    _validate_linear_metadata(story_id, entries)


def validate_story_id(story_id: str) -> str:
    """Require a canonical Linear issue identifier."""
    if STORY_ID_PATTERN.fullmatch(story_id) is None:
        raise ValueError(f"invalid story ID: {story_id[:100]!r}")
    return story_id


def _contains_symlink(relative_path: Path) -> bool:
    current = PROJECT_ROOT
    for part in relative_path.parts:
        current /= part
        if current.is_symlink():
            return True
    return False


def _pipeline_id_from_file(path: Path) -> str:
    try:
        matches = [
            match.group(1)
            for line in path.read_text(encoding="utf-8").splitlines()
            if (match := TOP_LEVEL_PIPELINE_ID_PATTERN.fullmatch(line)) is not None
        ]
    except (OSError, UnicodeError) as exc:
        raise ValueError(f"cannot read pipeline specification: {type(exc).__name__}") from None
    if len(matches) != 1:
        raise ValueError("pipeline specification requires one canonical top-level id")
    return matches[0]


def _pipeline_catalog() -> dict[str, Path]:
    """Build the unique ID catalog from direct regular non-hidden YAML files."""
    if _contains_symlink(PIPELINE_DIRECTORY):
        raise ValueError("pipeline directory must not contain symlinks")
    try:
        pipeline_root = (PROJECT_ROOT / PIPELINE_DIRECTORY).resolve(strict=True)
        entries = tuple(pipeline_root.iterdir())
    except OSError as exc:
        raise ValueError(f"cannot read pipeline catalog: {type(exc).__name__}") from None
    catalog: dict[str, Path] = {}
    for path in entries:
        if path.name.startswith(".") or path.suffix != ".yaml":
            continue
        try:
            is_regular_file = path.is_file() and not path.is_symlink()
        except OSError as exc:
            raise ValueError(f"cannot inspect pipeline catalog: {type(exc).__name__}") from None
        if not is_regular_file:
            continue
        pipeline_id = _pipeline_id_from_file(path)
        if pipeline_id in catalog:
            raise ValueError(f"duplicate pipeline id: {pipeline_id[:100]}")
        catalog[pipeline_id] = path
    return catalog


def resolve_pipeline_id(pipeline: str) -> str:
    """Resolve an ID or a confined repository pipeline YAML to its declared ID."""
    catalog = _pipeline_catalog()
    if PIPELINE_ID_PATTERN.fullmatch(pipeline) is not None:
        if pipeline not in catalog:
            raise ValueError(f"pipeline id does not exist exactly once: {pipeline[:100]}")
        return pipeline
    relative_path = Path(pipeline)
    expected_parent = PIPELINE_DIRECTORY.parts
    if relative_path.is_absolute() or relative_path.parts[:-1] != expected_parent:
        raise ValueError("pipeline specification must be directly beneath .pi/bmad/pipelines")
    if (
        relative_path.name.startswith(".")
        or relative_path.suffix != ".yaml"
        or _contains_symlink(relative_path)
    ):
        raise ValueError("pipeline specification must be a regular, non-symlink YAML file")
    try:
        pipeline_root = (PROJECT_ROOT / PIPELINE_DIRECTORY).resolve(strict=True)
        resolved_path = (PROJECT_ROOT / relative_path).resolve(strict=True)
        resolved_path.relative_to(pipeline_root)
    except (OSError, ValueError):
        raise ValueError("pipeline specification escapes or does not exist") from None
    if resolved_path.parent != pipeline_root or not resolved_path.is_file():
        raise ValueError("pipeline specification must be a direct regular file")
    declared_id = _pipeline_id_from_file(resolved_path)
    if catalog.get(declared_id) != resolved_path:
        raise ValueError("pipeline specification is not in the confined catalog")
    return declared_id


def validate_parent_model(model: str) -> str:
    """Require the exact parent-stage model before any external side effect."""
    if model != PARENT_MODEL:
        raise ValueError(f"parent model must be exactly {PARENT_MODEL}")
    return model


def validate_max_regressions(max_regressions: int) -> int:
    """Require an exact nonnegative integer within JSON's safe range."""
    if not is_regressions(max_regressions):
        raise ValueError(f"max regressions must be an integer from 0 to {MAX_SAFE_INTEGER}")
    return max_regressions


def build_pipeline_command(args: argparse.Namespace) -> list[str]:
    spec_file = str(
        Path(".pi")
        / "artifacts"
        / "implementation"
        / "stories"
        / f"{args.story_id}.md"
    )
    cmd = [
        "node", str(BMAD_CLI), "run", args.pipeline,
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
    parser.add_argument(
        "--pipeline",
        "--rundef",
        dest="pipeline",
        default=CREATE_STORY_RUNDEF,
        help="RunDef id or repository pipeline YAML (default: reusable full SDLC)",
    )
    parser.add_argument("--model", default=PARENT_MODEL,
                        help="Model for pipeline stages (fixed: GPT-5.6 Sol via OpenAI Codex)")
    parser.add_argument("--max-regressions", type=int, default=5, help="Max dev↔review regressions before failing (default 5)")
    parser.add_argument("--dry-run", action="store_true", help="Print command without executing")
    args = parser.parse_args()

    try:
        args.story_id = validate_story_id(args.story_id)
        args.model = validate_parent_model(args.model)
        args.max_regressions = validate_max_regressions(args.max_regressions)
        args.pipeline = resolve_pipeline_id(args.pipeline)
        validate_story_source_intake(args.story_id, args.pipeline)
    except ValueError as exc:
        log(f"❌ Pipeline preflight failed: {str(exc)[:450]}")
        return 2

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

    # pi-subagents refuses to register its tools when it sees a child context;
    # strip inherited markers so pipeline stages keep delegation capability
    # no matter what launched this runner (agent bash, CI, terminal).
    for inherited in ("PI_SUBAGENT_CHILD", "PI_SUBAGENT_CHILD_AGENT", "PI_SUBAGENT_PARENT_SESSION"):
        env.pop(inherited, None)

    cmd = build_pipeline_command(args)
    log(f"🔧 {' '.join(cmd)}")
    log(f"📁 cwd: {PROJECT_ROOT}")

    if args.dry_run:
        log("🏁 Dry run — exiting")
        return 0

    start = time.monotonic()
    try:
        proc = subprocess.Popen(cmd, cwd=str(PROJECT_ROOT), stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, env=env, text=True, bufsize=1)
    except OSError as exc:
        log(f"❌ Failed to start supervisor: {str(exc)[:450]}")
        return 127
    log(f"🏃 Pipeline PID: {proc.pid}")

    terminal_result_status: str | None = None
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            if len(line.encode("utf-8")) > EVENT_MAX_RAW_LINE_BYTES:
                log(bounded_diagnostic(line))
                continue
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                log(bounded_diagnostic(line))
                continue
            if isinstance(event, dict):
                event = bound_event(event)
            if valid_event(event):
                handle_event(event, args.story_id, issue_id, team_id)
                terminal_result_status = event["status"] if event["event"] == "result" else None
            else:
                log(bounded_diagnostic(line))
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

    if proc.returncode == 0 and terminal_result_status == "passed" and team_id:
        update_status(issue_id, team_id, "Done")
    if proc.returncode == 0 and terminal_result_status not in (None, "passed"):
        return 1
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
