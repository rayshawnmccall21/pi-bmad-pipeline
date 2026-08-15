#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""verify_docs.py — the docs gate: coverage of everything changed since main.

Recomputes the changed set EXACTLY the way the code-review workflow scopes
its changes (guides/code-review/load-story.md): the three-dot merge-base
diff `origin/main...HEAD` plus working-tree and staged diffs, combined,
committed and uncommitted treated equivalently. Then verifies the docs
stage's coverage manifest against that recomputed set:

  - every changed path appears exactly once (pipeline exhaust exempt);
  - "doc-updated" requires a docPath that ITSELF changed since main —
    a claim naming an untouched doc is a lie and fails;
  - the manifest's mergeBase must match the recomputed merge base, so a
    stale manifest from a previous cycle can never pass;
  - a missing manifest regresses to the docs stage with an instruction
    finding — the same self-correcting channel as dispositions.

Exit: 0 covered · 1 gate-failed (findings written; onFail: docs) ·
2 escalate (no origin/main, git failure).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as c  # noqa: E402

EXEMPT_PREFIXES = (
    ".pi/artifacts/", ".pi/pipeline/", ".pi/logs/", ".pi/state/",
    ".pi/qa-state/", "pr-diagram-out/",
)

INSTRUCTION = (
    "Update the project docs for every file changed since origin/main, then "
    "write .pi/artifacts/docs/coverage.json (schema docs-coverage.v1) with "
    "baseRef, mergeBase (git merge-base origin/main HEAD), and one entry per "
    "changed path: {path, disposition: doc-updated|no-doc-impact, docPath "
    "(required for doc-updated; the doc must itself be changed on this "
    "branch), reason (required for no-doc-impact)}. This gate recomputes the "
    "changed set with git diff origin/main...HEAD --name-only plus working "
    "tree and index, exactly like code-review scopes changes."
)


def changed_since_main() -> set[str] | None:
    """Mirror of code-review load-story scoping. None = cannot compute."""
    commands = [
        ["diff", "origin/main...HEAD", "--name-only"],
        ["diff", "--name-only"],
        ["diff", "--cached", "--name-only"],
    ]
    changed: set[str] = set()
    for args in commands:
        code, out = c.git(args)
        if code != 0:
            return None
        changed.update(line.strip() for line in out.splitlines() if line.strip())
    return {p for p in changed if not p.startswith(EXEMPT_PREFIXES)}


def load_manifest(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        doc = json.loads(path.read_text())
    except json.JSONDecodeError:
        return None
    if doc.get("schema") != "docs-coverage.v1" or not isinstance(doc.get("entries"), list):
        return None
    return doc


def verify(doc: dict, changed: set[str], merge_base: str) -> list[str]:
    problems: list[str] = []
    if doc.get("mergeBase") != merge_base:
        problems.append(
            f"manifest mergeBase {str(doc.get('mergeBase'))[:10]} != current "
            f"{merge_base[:10]} — regenerate after the latest commits")
    entries = doc["entries"]
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            problems.append("non-object manifest entry")
            continue
        path = entry.get("path")
        disposition = entry.get("disposition")
        if path in seen:
            problems.append(f"{path}: appears twice in the manifest")
        seen.add(path)
        if path not in changed:
            problems.append(f"{path}: in manifest but not changed since main")
            continue
        if disposition == "doc-updated":
            doc_path = entry.get("docPath")
            if not doc_path:
                problems.append(f"{path}: doc-updated without docPath")
            elif doc_path not in changed:
                problems.append(
                    f"{path}: claims doc-updated via {doc_path}, but that doc "
                    "did not change since main — unverified claim")
        elif disposition == "no-doc-impact":
            if not entry.get("reason"):
                problems.append(f"{path}: no-doc-impact without a reason")
        else:
            problems.append(f"{path}: unknown disposition {str(disposition)!r}")
    for path in sorted(changed - seen):
        problems.append(f"{path}: changed since main but not covered by the manifest")
    return problems


def emit_findings(out_dir: Path, problems: list[str]) -> None:
    findings = [{
        "fingerprint": "meta:docs-coverage",
        "severity": "info",
        "file": None,
        "line": None,
        "text": INSTRUCTION,
    }]
    findings += [{
        "fingerprint": "docs:" + c.sha256(p)[:16],
        "severity": "medium",
        "file": p.split(":")[0],
        "line": None,
        "text": f"Docs coverage gap: {p}",
    } for p in problems]
    c.write_findings_file(out_dir / "findings.json", findings)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True,
                    help="dir holding coverage.json; findings.json written here")
    ap.add_argument("--manifest", default=None)
    args = ap.parse_args(argv)
    out_dir = Path(args.out)

    code, merge_base = c.git(["merge-base", "origin/main", "HEAD"])
    if code != 0:
        print("verify-docs: cannot resolve merge-base with origin/main",
              file=sys.stderr)
        return c.EXIT_ESCALATE
    changed = changed_since_main()
    if changed is None:
        print("verify-docs: git diff failed", file=sys.stderr)
        return c.EXIT_ESCALATE

    manifest_path = Path(args.manifest or out_dir / "coverage.json")
    doc = load_manifest(manifest_path)
    if doc is None:
        emit_findings(out_dir, [f"{p}: changed since main but not covered "
                                "by the manifest" for p in sorted(changed)])
        print(f"verify-docs: no valid manifest at {manifest_path} — "
              f"{len(changed)} changed paths need docs coverage", file=sys.stderr)
        return c.EXIT_GATE

    problems = verify(doc, changed, merge_base)
    if problems:
        emit_findings(out_dir, problems)
        print(f"verify-docs: {len(problems)} coverage gaps", file=sys.stderr)
        return c.EXIT_GATE

    print(f"verify-docs: all {len(changed)} changed paths covered "
          f"({sum(1 for e in doc['entries'] if e.get('disposition') == 'doc-updated')} "
          "doc-updated)")
    return c.EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
