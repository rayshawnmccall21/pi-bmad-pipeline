# state/ — Context

> Durable pipeline state, filesystem persistence, reconciliation, and per-story dispatch locking.

## ADRs

- No planning ADR artifact is currently published. The `strip-1` specification makes `.pi/pipeline/state/<story-id>.json` the authoritative audit and resume surface.

## Invariants

- Persisted state records story, RunDef id/digest, spec, runner feature version, model/thinking, stages, regressions, timestamps, economics, and an optional canonical `upstreamHandoff` on the stage that will consume it.
- State loading validates serialized shape, stage map-key/id equality, and canonical sanitized handoff bytes before use; unsafe or oversized handoffs reject the state rather than being repaired.
- Reconciliation repairs interrupted running markers and internal contradictions against compiled stage IDs without depending on stage kind, while preserving accepted handoff bytes exactly.
- Every returned state snapshot, stage history, issue list, and factory result is immutable.
- Dispatch locks are per story, include run ownership metadata, reject live contention, and permit only defined stale-lock recovery.
- Public `done` maps to result status `passed`; terminal/current-stage fields remain internally consistent.

## Gotchas

- Reconciliation is repair after successful validation, not a substitute for accepting malformed JSON or non-canonical handoff strings.
- Resume identity checks belong in the action preparation flow; reconciliation must not rewrite a mismatched RunDef/spec/model into compatibility.
- Handoff belongs to the successor `StageState`, not the predecessor attempt history; replacing or clearing it must not mutate attempts, findings, timestamps, or history.
- The removed `current-run.json` pointer and evidence store are not alternate state sources and must not return.

## Learnings

- 2026-08-06 — A RunDef content digest is required in durable state; matching only the YAML ID can resume into a structurally different FSM.
- 2026-08-14 — ID-based reconciliation resets interrupted agent and code stages uniformly, preserving at-least-once recovery without fabricating attempt history.
- 2026-08-15 — Persisting a normalized handoff string on the successor provides byte-stable replay across filesystem round trips and interrupted-run reconciliation.
