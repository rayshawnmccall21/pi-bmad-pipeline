"""Shared seams for the review-gates scripts.

Exit-code contract (every script):
  0 = pass
  1 = gate-failed: blocking findings / recoverable state (v1.1 regress)
  2 = escalate: drift, timeout, budget, needs_human — never auto-retried
  3 = terminal failure: collection/validation error (fail closed)

All GitHub access shells out through gh() so tests can fake the binary
with the RG_GH env var. No third-party imports — stdlib only.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

EXIT_OK = 0
EXIT_GATE = 1
EXIT_ESCALATE = 2
EXIT_FAIL = 3

BOT_REST = "coderabbitai[bot]"  # REST user.login
BOT_GQL = "coderabbitai"        # GraphQL author.login (no [bot] suffix)

FINDINGS_MAX_COUNT = 50
FINDINGS_MAX_ITEM_CHARS = 2048
FINDINGS_MAX_TOTAL_CHARS = 65536

DISPOSITIONS = ("fix", "false_positive", "outdated_fixed", "duplicate", "needs_human")


class GhError(RuntimeError):
    def __init__(self, args: list[str], code: int, stderr: str):
        super().__init__(f"gh {' '.join(args[:4])}… exited {code}: {stderr[:300]}")
        self.code = code


def gh(args: list[str], *, input_text: str | None = None) -> str:
    """Run gh (or the RG_GH fake) and return stdout. Raises GhError."""
    binary = os.environ.get("RG_GH", "gh")
    proc = subprocess.run(
        [binary, *args], capture_output=True, text=True, input=input_text
    )
    if proc.returncode != 0:
        raise GhError(args, proc.returncode, proc.stderr)
    return proc.stdout


def gh_json(args: list[str]):
    return json.loads(gh(args))


def git(args: list[str], *, cwd: str | None = None) -> tuple[int, str]:
    proc = subprocess.run(["git", *args], capture_output=True, text=True, cwd=cwd)
    return proc.returncode, proc.stdout.strip()


def die(code: int, message: str) -> "NoReturn":  # noqa: F821
    print(f"review-gates: {message}", file=sys.stderr)
    raise SystemExit(code)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def write_json_atomic(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name)
    with os.fdopen(fd, "w") as fh:
        json.dump(obj, fh, indent=2, sort_keys=False)
        fh.write("\n")
    os.replace(tmp, path)


def content_ref(path: Path) -> str:
    return f"{path.name}@sha256:{sha256(path.read_text())[:12]}"


def sanitize_text(text: str, limit: int) -> str:
    """Strip control characters and cap length before prompt-adjacent use."""
    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    cleaned = cleaned.replace("\r", "")
    return cleaned[:limit]


# ---------------------------------------------------------------- loop-state

def loop_state_path(out_dir: Path) -> Path:
    return out_dir / "loop-state.json"


def loop_state_load(out_dir: Path) -> dict:
    path = loop_state_path(out_dir)
    if not path.exists():
        return {}
    try:
        state = json.loads(path.read_text())
    except json.JSONDecodeError:
        die(EXIT_FAIL, f"loop-state.json is unreadable: {path}")
    chain = state.get("chain", {})
    body = {k: v for k, v in state.items() if k != "chain"}
    if chain.get("hash") != sha256((chain.get("prev") or "") + canonical(body)):
        die(EXIT_FAIL, "loop-state.json chain hash mismatch — state was edited")
    return state


def loop_state_save(out_dir: Path, state: dict) -> None:
    prev = (state.get("chain") or {}).get("hash", "")
    body = {k: v for k, v in state.items() if k != "chain"}
    state = dict(body)
    state["chain"] = {"prev": prev, "hash": sha256(prev + canonical(body))}
    write_json_atomic(loop_state_path(out_dir), state)


def loop_state_init(out_dir: Path, *, story_id: str, pr: int, repo: str,
                    branch: str, head: str) -> dict:
    state = {
        "schema": "loop-state.v1",
        "storyId": story_id,
        "pr": pr,
        "repo": repo,
        "branch": branch,
        "expectedHead": head,
        "reviewCycles": {"count": 0, "max": 3},
        "reRequested": [],
        "fingerprints": {},
        "fpCounts": {"falsePositive": 0, "total": 0},
        "pendingApplied": [],
        "pendingUnapplied": [],
        "updatedAt": now_iso(),
    }
    loop_state_save(out_dir, state)
    return loop_state_load(out_dir)


# ---------------------------------------------------------------- preflight

def preflight_worktree(state: dict, *, allow_detached: bool = False) -> None:
    """Assert the local checkout matches the loop's identity (PR #4 removed
    branch pinning from supervisor resume — every script re-asserts it)."""
    if allow_detached:
        return
    code, branch = git(["rev-parse", "--abbrev-ref", "HEAD"])
    if code != 0:
        die(EXIT_ESCALATE, "preflight: not inside a git worktree")
    expected_branch = state.get("branch")
    if expected_branch and branch != expected_branch:
        die(EXIT_ESCALATE,
            f"preflight: on branch '{branch}', loop expects '{expected_branch}'")


def local_head() -> str | None:
    code, head = git(["rev-parse", "HEAD"])
    return head if code == 0 else None


def assert_head_matches(state: dict, live_head: str) -> None:
    expected = state.get("expectedHead")
    if expected and live_head != expected:
        die(EXIT_ESCALATE,
            f"head drift: PR head {live_head[:10]} != expected {expected[:10]} "
            "— external interference, escalating (never a regress)")


# ------------------------------------------------------------- findings file

def write_findings_file(path: Path, findings: list[dict]) -> None:
    """Capped + sanitized stage-findings.v1 — the only channel that is
    lifted into an agent prompt. Missing/oversized handling is fail-closed
    on the consumer side; the producer enforces the caps here."""
    capped = []
    total = 0
    for f in findings[:FINDINGS_MAX_COUNT]:
        text = sanitize_text(str(f.get("text", "")), FINDINGS_MAX_ITEM_CHARS)
        item = {
            "fingerprint": str(f.get("fingerprint", ""))[:128],
            "severity": str(f.get("severity", "high")),
            "file": sanitize_text(str(f.get("file") or ""), 256),
            "line": f.get("line"),
            "text": text,
        }
        total += len(text)
        if total > FINDINGS_MAX_TOTAL_CHARS:
            break
        capped.append(item)
    write_json_atomic(path, {"schema": "stage-findings.v1", "findings": capped})


# ----------------------------------------------------------------- severity

SEVERITY_MARKS = [
    ("🔴", "critical"),
    ("🟠", "high"),
    ("🟡", "medium"),
    ("🔵", "info"),
]


def parse_severity(body: str) -> str:
    """Map CodeRabbit's live marker format (`_🟠 Major_` etc.) to the
    pi-bmad severity vocabulary. Unknown = high (fail closed)."""
    head = body[:200]
    for mark, sev in SEVERITY_MARKS:
        if mark in head:
            return sev
    return "high"
