# actions/ — Context

> Composition root for one locked, durable YAML-defined pipeline run.

## ADRs

- No planning ADR artifact is currently published. Actions coordinate mechanism only and do not own audit, evidence, pull-request, or merge policy.
- The default executor factory preserves its model/thinking/Pi options contract while composing `PiCliWorkflowExecutor` and `LocalCodeExecutor` behind one `StageExecutorDispatcher`; tests and embedders may replace that injected factory.

## Invariants

- `runPipelineAction` acquires the lock, then preparation loads state, registers gates, selects/compiles YAML, resolves the model, resolves fresh or reconciled state, constructs an executor through the injected factory, and invokes the FSM.
- After a lock is acquired, execution failures are caught and returned as frozen `RunResult` data. Request validation and lock acquisition itself occur outside that catch boundary and may throw.
- The dispatch lock is released in `finally`, and state persistence/event effects enter through injected dependencies.
- Agent and code stages share the ordinary lifecycle events; payload-gate events are emitted only for agent stages.
- Settlement emits one terminal result event and preserves durable state as the authoritative run record.

## Gotchas

- Keep `run-pipeline-action.ts`, `run-pipeline-execution.ts`, and `run-pipeline-settlement.ts` separated; moving policy back into the composition root recreates a god module.
- Resume identity includes the RunDef digest, so code command/argv changes cannot reuse prior state.
- `projectRoot` is passed unchanged as the exact executor cwd; actions do not create a worktree.
- Register payload gates before compiling YAML that references them.

## Learnings

- 2026-08-14 — Mixed-stage composition belongs at the existing executor factory seam; the action and FSM can keep one injected executor contract.
