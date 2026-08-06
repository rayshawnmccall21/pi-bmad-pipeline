# state/ — Context

> Durable pipeline state, filesystem persistence, reconciliation, and per-story dispatch locking.

## ADRs

- No planning ADR artifact is currently published. The `strip-1` specification makes `.pi/pipeline/state/<story-id>.json` the authoritative audit and resume surface.

## Invariants

- Persisted state records story, RunDef id/digest, spec, worktree/branch, runner feature version, model/thinking, stages, regressions, timestamps, and economics. The action/git boundary supplies the canonical worktree path.
- State loading validates serialized shape before use; reconciliation repairs interrupted running markers and internal contradictions against compiled stages.
- Every returned state snapshot, stage history, issue list, and factory result is immutable.
- Dispatch locks are per story, include run ownership metadata, reject live contention, and permit only defined stale-lock recovery.
- Public `done` maps to result status `passed`; terminal/current-stage fields remain internally consistent.

## Gotchas

- Reconciliation is repair after successful validation, not a substitute for accepting malformed JSON.
- Resume identity checks belong in the action preparation flow; reconciliation must not rewrite a mismatched RunDef/spec/model into compatibility.
- The removed `current-run.json` pointer and evidence store are not alternate state sources and must not return.

## Learnings

- 2026-08-06 — A RunDef content digest is required in durable state; matching only the YAML ID can resume into a structurally different FSM.
