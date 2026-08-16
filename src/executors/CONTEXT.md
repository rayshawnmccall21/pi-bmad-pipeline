# executors/ — Context

> Process boundary that dispatches each compiled stage to its matching concrete executor.

## ADRs

- No planning ADR artifact is currently published. `StageExecutorDispatcher` is the single exhaustive selector for the closed `agent | code` union. It owns exactly one Pi delegate and one local-code delegate; there is no registry, plugin API, or factory map.

## Invariants

- `WorkflowExecutor.execute` accepts compiled stage/run identity plus optional branded `upstreamHandoff` context and returns output, exit, duration, usage, timeout, abort, parse, or safe diagnostic information as data.
- Agent stages run through `PiCliWorkflowExecutor`; code stages run through `LocalCodeExecutor`. Each concrete executor synchronously rejects the wrong kind before starting its child mechanism.
- Pi terminal output is accepted only when pi-bmad contract/schema gating accepts it under the emission key and its workflow matches the active stage.
- Pi renders a defensively re-sanitized handoff after `priorFindings` as JSON inside a dynamically sized backtick fence with an explicit untrusted-data warning; it never transports handoff data through stdin or environment variables.
- Local code uses the exact command and literal argv with no shell, exact `projectRoot` cwd, ignored stdin, inherited `process.env`, and continuously drained output. Successful output is discarded; failure diagnostics are bounded and redacted.
- Timeout or abort sends SIGTERM with bounded SIGKILL escalation: Pi stages signal the direct child, while detached code stages signal the child process group.

## Gotchas

- `projectRoot` is the exact child cwd; no executor creates or selects a worktree.
- The Pi emission key is per process and secret-like: pass it through the child environment but never emit it in events/debug logs.
- Upstream payload text is model-authored data, not trusted instructions or authenticated output for the invoked child; preserve the warning, dynamic fence, and provenance boundary together.
- Code execution is trusted local execution, not a sandbox, and interrupted commands may run again under at-least-once recovery.

## Learnings

- 2026-08-14 — Literal no-shell argv and an exhaustive two-way dispatcher add deterministic local execution without exposing process-mechanism branching to the FSM.
- 2026-08-15 — Prompt-only StageHandoff can enrich successor reasoning without altering child spawn transport, emission provenance, or the existing findings summary.
