# events/ — Context

> Redacted, immutable, line-oriented event and debug records for supervisor observability.

## ADRs

- No planning ADR artifact is currently published. The `strip-1` specification defines JSONL events as the process API and limits the vocabulary to pipeline mechanism.

## Invariants

- Every `PipelineCliEvent` has one discriminator plus `ts` and `storyId`; serialization produces exactly one JSON line.
- Event serialization redacts credential-shaped text before it reaches an injected sink.
- The supported event set is run, stage, gate, budget, progress, result, and error; evidence, PR, and merge variants do not belong here.
- Pipeline event emitter clocks and sinks are injected. The separate debug helper defaults to `process.env`, the current time, and stderr, but exposes environment and write seams for tests.

## Gotchas

- Domain vocabularies such as stage-decision kinds and run status are owned by core/state and intentionally carried as strings here.
- Never log emission keys or raw child environments in debug fields.
- Adding an event variant changes a public wire contract and requires serializer/emitter tests.

## Learnings

- 2026-08-06 — Narrowing the event union prevents deleted policy capabilities from surviving as misleading API promises.
