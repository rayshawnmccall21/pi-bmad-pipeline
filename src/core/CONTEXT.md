# core/ — Context

> Pure routing, decision, budget, transition, and durable FSM execution mechanisms.

## ADRs

- No planning ADR artifact is currently published. The `strip-1` decision keeps the FSM as mechanism while moving pipeline composition and product policy to YAML workflows.

## Invariants

- Compiled stages execute in order; gate failure can route only to an earlier configured stage and regression count is bounded.
- State is persisted after every transition, including running markers and terminal outcomes.
- Executor failures, aborts, timeouts, parse failures, gate failures, and budget failures become typed outcomes rather than uncaught runtime errors.
- Core has no process, filesystem, CLI wire-format, or ambient event dependency; effects and observers are injected.
- Token and dollar economics include every recorded attempt and are checked against stage/run ceilings.

## Gotchas

- Resume starts at the first incomplete compiled stage; changing completion semantics affects reconciliation and routing together.
- A payload can pass only after process/output validation and any configured gate both pass.
- Keep event vocabulary outside core: observers carry domain information, not serialized JSONL.

## Learnings

- 2026-08-06 — Resume safety requires binding state to RunDef identity and passing active story identity into payload-gate evaluation.
