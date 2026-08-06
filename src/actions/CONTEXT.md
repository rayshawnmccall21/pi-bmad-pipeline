# actions/ — Context

> Composition root for one locked, durable YAML-defined pipeline run.

## ADRs

- No planning ADR artifact is currently published. The governing repository decision is the `strip-1` specification: actions coordinate mechanism only and do not own audit, evidence, pull-request, or merge policy.

## Invariants

- `runPipelineAction` acquires the lock, then preparation loads state, registers gates, selects/compiles YAML, resolves the model, ensures/canonicalizes the worktree, and resolves fresh or reconciled state before FSM execution and settlement.
- After a lock is acquired, execution failures are caught and returned as frozen `RunResult` data. Request validation and lock acquisition itself occur outside that catch boundary and may throw.
- The dispatch lock is released in `finally`, and state persistence/event effects enter through injected dependencies.
- Settlement emits one terminal result event and preserves the durable state as the authoritative run record.

## Gotchas

- Keep `run-pipeline-action.ts`, `run-pipeline-execution.ts`, and `run-pipeline-settlement.ts` separated; moving policy back into the composition root recreates a god module.
- Resume identity includes RunDef id/digest, spec, worktree, branch, model, and thinking. Do not silently reuse state when any identity differs.
- Register payload gates before compiling YAML that references them.

## Learnings

- 2026-08-06 — Removing evidence, PR, merge, and audit side effects made the action lifecycle explicit: lock → prepare → execute → settle → release.
