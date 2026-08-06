---
name: product-agent
description: >
  Product knowledge for the pi-bmad-pipeline command-line agent surface. How to
  build, invoke, and verify the pipeline supervisor CLI. Maintained by TEA during e2e-plan exploration.
updated: 2026-08-06T16:05:18Z
stories: [strip-1]
---

# pi-bmad-pipeline CLI — Product Knowledge

## Launch

Build from the repository root:

```bash
npm run build
```

Invoke the built CLI with:

```bash
node dist/src/cli.js <command>
```

The expected ready signal is immediate CLI output followed by an exit code; this is a non-interactive command-line product, not a Pi extension or persistent TUI.

Current exploration blocker: the TypeScript build succeeds, but every attempted built CLI command fails before argument dispatch because Node cannot resolve `/Users/Apple/pi-bmad/src/index.js`, imported through the local `pi-bmad` dependency's TypeScript contracts barrel. Therefore current help, version, run, and command-error rendering could not be observed live in this worktree.

## Navigation

The human journey is shell-driven:

1. Open a terminal in the project/worktree root.
2. Run `node dist/src/cli.js help` to inspect available commands and usage.
3. Run `node dist/src/cli.js version` to inspect the package version.
4. Run `node dist/src/cli.js run <rundef-id> --story <story-id> --spec <path>` (plus optional output/model controls) to execute a discovered YAML FSM.
5. Read human output on stdout/stderr, or add the CLI's JSONL option and consume one-line events plus the process exit code.

For strip-1, adversarial navigation also invokes `audit`, `iso`, `merge`, `run --no-pr`, and `run` without a rundef ID to verify fail-closed grammar.

## Surface Map

- `help`: terminal usage text. Desired strip-1 vocabulary is exactly `run`, `help`, and `version`.
- `version`: one-shot version output.
- `run <rundef-id>`: discovered-YAML pipeline execution; observable through JSONL run/stage/gate/budget/progress/result/error events, durable `.pi/pipeline/state/<storyId>.json`, lock/worktree files, child-process argv/debug events, and exit status.
- Invalid command/option/positional: typed terminal error and non-zero exit.
- There is no browser, mobile, or interactive TUI surface.

## Current Screenshots

These are captured terminal transcripts and have been read:

- `screenshots/cli-help-current.txt` — build succeeds, but `help` crashes during module resolution before rendering usage.
- `screenshots/cli-version-current.txt` — `version` hits the same pre-dispatch module-resolution crash.
- `screenshots/cli-merge-current.txt` — deleted-command baseline cannot be observed because the same import failure happens first.

## Learnings

- This package is a standalone CLI that supervises fresh Pi child processes; it is not itself a Pi extension.
- The strongest live observations are command text/exit codes, JSONL stdout, structured debug stderr, durable state JSON, and spawned argv captured with a fake child.
- A real end-to-end run must use a hermetic fixture project and fake/stub Pi executable so tests do not invoke a network or an unbounded agent.
- Current built-product exploration is blocked by local file-dependency runtime resolution, despite a successful `tsc` build. Verification must either fix/provision that dependency's built entry point or invoke a supported source-runtime launcher before testing CLI behavior.
- The repository has no PRD, epics document, project SYSTEM context, UI mock, golden, or platform research catalog in this worktree; the story/spec is the available acceptance contract.
