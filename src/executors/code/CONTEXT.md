# executors/code — Context

> Local process executor for deterministic code stages.

## ADRs

- No planning ADR artifact is currently published. `StageExecutorDispatcher` is the single exhaustive selector for the closed `agent | code` union. The `LocalCodeExecutor` is the one concrete code delegate for pipeline branches whose stages are `kind: "code"`; there is no registry, plugin API, or factory map.

## Invariants

- `WorkflowExecutor.execute` accepts a compiled stage/run identity and returns output, exit, duration, usage, timeout, abort, parse, or safe diagnostic information as data.
- Code stages run through `LocalCodeExecutor`; agent stages run through the Pi delegate. Each concrete executor synchronously rejects the wrong kind before starting its child mechanism.
- The code stage uses the exact command and literal argv with `shell: false`, the exact `projectRoot` cwd, ignored stdin, inherited `process.env`, and continuously drained output. Successful output is discarded; failure diagnostics are bounded and redacted.
- Timeout or abort sends SIGTERM with bounded SIGKILL escalation: Pi stages signal the direct child, while detached code stages signal the child process group.

## Gotchas

- `projectRoot` is the exact child cwd; no executor creates or selects a worktree.
- The Pi emission key is per process and secret-like: pass it through the child environment but never emit it in events/debug logs.
- Code execution is trusted local execution, not a sandbox, and interrupted commands can replay under at-least-once semantics.

## Learnings

- 2026-08-14 — No shell, literal argv, and a two-way exhaustive dispatcher keep local execution deterministic without exposing process-mechanism branching to the FSM.
- 2026-08-14 — Versioned payload migrations should use an explicit dual-read consumer: retain the exact stage v1 shape, admit only canonical stage v2 shape, and fail closed on unknown versions.
