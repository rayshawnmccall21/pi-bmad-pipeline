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
- Stage decisions are kind-aware: agent stages require validated authenticated output, while code stages pass on exit `0` with `output: null` and never fabricate a payload.
- Nonzero/null code exits are terminal failures; any attached diagnostic is already bounded and redacted by the executor before core sees it.
- An agent payload can pass only after process/output validation and any configured gate both pass.
- Keep event vocabulary outside core: observers carry domain information, not serialized JSONL.

## Learnings

- 2026-08-06 — Resume safety requires binding state to RunDef identity and passing active story identity into payload-gate evaluation.
- 2026-08-14 — A stage-kind-neutral FSM still needs kind-aware decision semantics because authenticated output is mandatory for agents but intentionally absent for successful code stages.
