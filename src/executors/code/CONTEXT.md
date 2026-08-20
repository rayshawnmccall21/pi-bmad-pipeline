# executors/code — Context

> Local process executor for deterministic code stages.

## ADRs

- No planning ADR artifact is currently published. `StageExecutorDispatcher` is the single exhaustive selector for the closed `agent | code` union. The `LocalCodeExecutor` is the one concrete code delegate for pipeline branches whose stages are `kind: "code"`; there is no registry, plugin API, or factory map.

## Invariants

- `WorkflowExecutor.execute` accepts a compiled stage/run identity and returns output, exit, duration, usage, timeout, abort, parse, or safe diagnostic information as data.
- Code stages run through `LocalCodeExecutor`; agent stages run through the Pi delegate. Each concrete executor synchronously rejects the wrong kind before starting its child mechanism.
- The code stage uses the exact command and literal argv with `shell: false`, the exact `projectRoot` cwd, ignored stdin, inherited `process.env`, and continuously drained output. Successful output is discarded; failure diagnostics are bounded and redacted.
- On settlement, `buildResult` may add a frozen `findings` array only when the child exits `1` with a declared `findingsFile` and was neither timed out nor aborted. The file must be parseable JSON whose root has `schema: "stage-findings.v1"` and an array `findings` (extra root keys are accepted); otherwise the field is omitted. Non-object entries are skipped and string fields are sanitized before formatting; each item is capped at 2,048 characters, lifting stops at 50 items or before exceeding 65,536 total characters, and a raw file over 262,144 characters lifts nothing.
- Timeout or abort sends SIGTERM with bounded SIGKILL escalation: Pi stages signal the direct child, while detached code stages signal the child process group.

## Gotchas

- `projectRoot` is the exact child cwd; no executor creates or selects a worktree.
- `findingsFile` is resolved with `path.resolve(projectRoot, findingsFile)`, while RunDef validation requires only a nonempty string. Absolute paths and `..` traversal are not rejected, so pipeline YAML is trusted configuration rather than a project-root confinement boundary.
- The Pi emission key is per process and secret-like: pass it through the child environment but never emit it in events/debug logs.
- Code execution is trusted local execution, not a sandbox, and interrupted commands can replay under at-least-once semantics.

## Learnings

- 2026-08-14 — No shell, literal argv, and a two-way exhaustive dispatcher keep local execution deterministic without exposing process-mechanism branching to the FSM.
- 2026-08-14 — Versioned payload migrations should use an explicit dual-read consumer: retain the exact stage v1 shape, admit only canonical stage v2 shape, and fail closed on unknown versions.
