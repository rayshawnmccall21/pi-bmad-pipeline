# core/ — Context

> Pure routing, decision, budget, transition, and durable FSM execution mechanisms.

## ADRs

- No planning ADR artifact is currently published. The `strip-1` decision keeps the FSM as mechanism while moving pipeline composition and product policy to YAML workflows.

## Invariants

- Compiled stages execute in order; gate failure can route only to an earlier configured stage and regression count is bounded.
- State is persisted after every transition, including running markers, successor handoffs, and terminal outcomes.
- Only the authenticated current-stage output payload may become a handoff; core normalizes it once and attaches it to the actual routed successor without changing gate decisions.
- A missing, invalid, or oversized payload clears the successor's prior handoff rather than replaying stale context; `priorFindings` remains the regression fallback.
- Executor failures, aborts, timeouts, parse failures, gate failures, and budget failures become typed outcomes rather than uncaught runtime errors.
- Core has no process, filesystem, CLI wire-format, or ambient event dependency; effects and observers are injected. Direct embedders provide `runId` and `attestScope`, and consume the exported scope-attestation request/result contracts.
- Token and dollar economics include every recorded attempt and are checked against stage/run ceilings.
- Passed code review is persisted as a trusted Git scope checkpoint; attaching the first checkpoint or direct final receipt to a valid legacy nonterminal state upgrades its runner feature version atomically in the same frozen transition. Final attestation re-observes current scope even when a preterminal receipt is already durable, persists the current receipt before `done`, reuses the checkpoint's durable run ID across retries, and routes reviewed-byte drift back through review plus downstream stages.

## Gotchas

- Resume normally starts at the first incomplete compiled stage. Before that selection, only a valid older nonterminal state with a durably passed code-review stage and no checkpoint/receipt persists a budget-neutral reset of review plus downstream; malformed, newer, terminal, and checkpoint-bearing states do not enter this recovery.
- Stage decisions are kind-aware: agent stages require validated authenticated output, while code stages pass on exit `0` with `output: null` and never fabricate a payload.
- Code exit semantics fail closed: exit `1` with valid nonempty lifted findings becomes a routable `gate-failed` outcome, exit `1` without findings is terminal, and exit `>= 2` or null is terminal. Any attached diagnostic is already bounded and redacted before core sees it.
- An agent payload can pass only after process/output validation and any configured gate both pass; handoff acceptance is downstream of pass/fail and routing evaluation.
- Forward progress and regression both target the routed successor, so handoff updates must follow `nextStageId`, not arithmetic stage order.
- Keep event vocabulary outside core: observers carry domain information, not serialized JSONL.
- Scope observation remains injected; core owns only typed attestation sequencing, persistence order, bounded rerouting, and current-scope re-attestation after an interrupted preterminal receipt. A durable receipt is never a shortcut to `done`. Legacy missing-checkpoint recovery reruns review before docs and captures newly reviewed current bytes; it never reconstructs a checkpoint from Git, stale handoff, prior result, or invocation identity.

## Learnings

- 2026-08-06 — Resume safety requires binding state to RunDef identity and passing active story identity into payload-gate evaluation.
- 2026-08-14 — A stage-kind-neutral FSM still needs kind-aware decision semantics because authenticated output is mandatory for agents but intentionally absent for successful code stages.
- 2026-08-15 — Treating StageHandoff as successor state keeps replay deterministic and preserves the existing gate and regression-summary rails.
- 2026-08-20 — Final settlement must be receipt-driven: a durable preterminal receipt is recovery evidence, not permission to skip fresh scope observation.
