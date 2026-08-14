# executors/ — Context

> Process boundary that dispatches each compiled stage to its matching concrete executor.

## ADRs

- No planning ADR artifact is currently published. `StageExecutorDispatcher` is the single exhaustive selector for the closed `agent | code` union. It owns exactly one Pi delegate and one local-code delegate; there is no registry, plugin API, or factory map.

## Invariants

- `WorkflowExecutor.execute` accepts compiled stage/run identity and returns output, exit, duration, usage, timeout, abort, parse, or safe diagnostic information as data.
- Agent stages run through `PiCliWorkflowExecutor`; code stages run through `LocalCodeExecutor`. Each concrete executor synchronously rejects the wrong kind before starting its child mechanism.
- Pi terminal output is accepted only when pi-bmad contract/schema gating accepts it under the emission key and its workflow matches the active stage.
- Local code uses the exact command and literal argv with no shell, exact `projectRoot` cwd, ignored stdin, inherited `process.env`, and continuously drained output. Successful output is discarded; failure diagnostics are bounded and redacted.
- Timeout or abort sends SIGTERM with bounded SIGKILL escalation: Pi stages signal the direct child, while detached code stages signal the child process group.

## Gotchas

- `projectRoot` is the exact child cwd; no executor creates or selects a worktree.
- The Pi emission key is per process and secret-like: pass it through the child environment but never emit it in events/debug logs.
- Code execution is trusted local execution, not a sandbox, and interrupted commands may run again under at-least-once recovery.

## Learnings

- 2026-08-14 — Literal no-shell argv and an exhaustive two-way dispatcher add deterministic local execution without exposing process-mechanism branching to the FSM.
