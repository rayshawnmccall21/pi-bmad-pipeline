# executors/ — Context

> Process boundary that executes one compiled stage in a fresh hermetic Pi child and returns typed data.

## ADRs

- No planning ADR artifact is currently published. The retained `strip-1` execution decision is one fresh Pi child per YAML stage with one explicit pi-bmad extension.

## Invariants

- `WorkflowExecutor.execute` accepts compiled stage/run identity and returns output, exit, duration, usage, timeout, abort, or parse information as data.
- Pi children run in the story worktree with discovery/sessions disabled, offline mode enabled, stdin ignored, and exactly one explicit pi-bmad extension.
- Terminal headless output is accepted only when pi-bmad contract/schema gating accepts it under the emission key and its workflow matches the active stage. Story identity is checked later by configured payload gates.
- Timeout or abort sends SIGTERM and escalates to SIGKILL after a bounded grace period.
- Child JSONL is parsed incrementally; malformed or missing terminal output fails closed.

## Gotchas

- `projectRoot` is identity/config context while `worktreeCwd` is the child command cwd; do not collapse them.
- The emission key is per process and secret-like: pass it through the child environment but never emit it in events/debug logs.
- Stage-extension argv plumbing was deliberately removed. Reintroducing another `-e` slot violates the single-extension boundary.

## Learnings

- 2026-08-06 — Hermetic spawning depends on both closed stdin and offline startup; provenance must be checked after JSONL parsing, not inferred from process exit alone.
