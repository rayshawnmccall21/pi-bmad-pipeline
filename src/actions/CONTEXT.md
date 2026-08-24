# actions/ — Context

> Composition root for one locked, durable YAML-defined pipeline run.

## ADRs

- No planning ADR artifact is currently published. Actions coordinate mechanism only and do not own audit, evidence, pull-request, or merge policy.
- The default executor factory preserves its model/thinking/Pi options contract while composing `PiCliWorkflowExecutor` and `LocalCodeExecutor` behind one `StageExecutorDispatcher`; tests and embedders may replace that injected factory.
- `RunPipelineActionDeps` is the public composition seam. Omitted effects use the real defaults; any replacement for `attestScope` must remain a trusted `ScopeAttestor`.

## Invariants

- `runPipelineAction` acquires the lock, then preparation loads state, registers gates, selects/compiles YAML, resolves the model, resolves fresh or reconciled state, constructs an executor through the injected factory, and invokes the FSM.
- After a lock is acquired, execution failures are caught and returned as frozen `RunResult` data. Request validation and lock acquisition itself occur outside that catch boundary and may throw.
- The dispatch lock is released in `finally`; state persistence enters through injected dependencies, while event output and time enter through the request's injected `sink` and `now` seams.
- Agent and code stages share the ordinary lifecycle events; payload-gate events are emitted only for agent stages.
- Settlement emits one terminal result event and preserves durable state as the authoritative run record.
- The composition root invokes the fixed-argv Git scope attestor only during locked FSM execution and binds observations to the exact project root and authenticated run identity; final retry uses the durable checkpoint run identity rather than a fresh lock invocation ID.
- Git attestation accepts only an `origin/HEAD` default of `main` or `master`, requires matching local/remote refs at one lowercase 40-hex OID, and re-reads that identity to reject a base that moves during authentication.
- Canonical observed scope combines unique merge-base-to-`HEAD` committed actions with dirty actions and deliberately excludes `.pi/pipeline/` durable runner state. The unique merge base identifies the story fork, while the authenticated synchronized current default tip remains the receipt `baseOid` trust anchor; default-only post-fork paths are excluded and never read or tombstoned.

## Gotchas

- Keep `run-pipeline-action.ts`, `run-pipeline-execution.ts`, and `run-pipeline-settlement.ts` separated; moving policy back into the composition root recreates a god module.
- Resume identity includes the RunDef digest, so code command/argv changes cannot reuse prior state.
- `projectRoot` is passed unchanged as the exact executor cwd; actions do not create a worktree.
- Register payload gates before compiling YAML that references them.
- Never accept child/model filenames as mutation authority; the default attestor derives canonical merge-base-to-`HEAD` committed plus dirty observations from Git and physically confined repository reads. Its fixed docs classifier excludes prompts, skills, specs, workflow/configuration, hidden instruction trees, and executable context Markdown.
- A committed or exact staged/unstaged tracked deletion is a deterministic tombstone, distinct from a present empty or zero-byte file. Rename, copy, unmerged, mixed, malformed, and unsupported statuses remain rejected.
- A coded `ENOENT` is normalized only when stable, unchanged Git evidence confirms deletion absence. Attestation rejects and fails closed on ambiguous evidence or topology, a reappearance or read race, and any unrelated read error; none can authorize a checkpoint or receipt.

## Learnings

- 2026-08-14 — Mixed-stage composition belongs at the existing executor factory seam; the action and FSM can keep one injected executor contract.
- 2026-08-20 — Default-base authentication must bind symbolic default-branch policy, local/remote object identity, and a second read against movement before repository bytes can authorize a receipt.
