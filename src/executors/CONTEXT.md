# executors/ — Context

> Process boundary that dispatches each compiled stage to its matching concrete executor.

## ADRs

- No planning ADR artifact is currently published. `StageExecutorDispatcher` is the single exhaustive selector for the closed `agent | code` union. It owns exactly one Pi delegate and one local-code delegate; there is no registry, plugin API, or factory map.

## Invariants

- `WorkflowExecutor.execute` accepts compiled stage/run identity plus optional branded `upstreamHandoff` context and returns output, lifted findings, exit, duration, usage, timeout, abort, parse, or safe diagnostic information as data.
- Primary concrete seams are `StageExecutorDispatcher`, `PiCliWorkflowExecutor`, and `LocalCodeExecutor`; public exports also include workflow contracts, stable IDs/constants, findings lifting, and Pi argument/parser/output/extension/run/spawn helpers and types. Local execution injects spawn/clock/kill/timeouts; Pi execution injects spawn or the stage runner.
- Agent stages run through `PiCliWorkflowExecutor`; code stages run through `LocalCodeExecutor`. Each concrete executor synchronously rejects the wrong kind before starting its child mechanism.
- Pi terminal output is accepted only when pi-bmad contract/schema gating accepts it under the emission key and its workflow matches the active stage. Pi 0.84 discovery for extensions, skills, prompt templates, themes, and context files is disabled before the explicit required pi-bmad extension and additive repeated stage extension paths; approval and startup networking are also disabled. Compiled agent stages may add observability pool/name/tag arguments.
- Pi child spawning removes inherited Pi session, model, pipeline, extension, coding-agent-directory, and child-subagent control state before applying the reviewed invocation environment, and always disables telemetry. Non-PI environment remains inherited; provider credentials are the caller's responsibility.
- Pi stdout parsing is fatal UTF-8, preserves LF framing with optional CR stripping, and fails closed above 16 MiB total, 1 MiB per pending or complete line, or 10,000 combined retained records and malformed-line issues. Every nonblank line is parsed, but non-terminal `message_update` and `tool_execution_update` progress events are discarded after parsing and do not consume retained-entry capacity; wire-byte and line limits still cover all input. Terminal parser failure stops retention, sends SIGTERM with the existing bounded SIGKILL escalation, and prevents any earlier envelope from being accepted.
- Pi renders a defensively re-sanitized handoff after `priorFindings` as JSON inside a dynamically sized backtick fence with an explicit untrusted-data warning; it never transports handoff data through stdin or environment variables.
- Local code uses the exact command and literal argv with no shell, exact `projectRoot` cwd, ignored stdin, inherited `process.env`, and continuously drained output. Successful output is discarded; failure diagnostics are bounded and redacted.
- Structured findings lift only from a declared `findingsFile` after a clean exit `1`, never after timeout/abort. The root must contain `schema: "stage-findings.v1"` and an array `findings` (extra root keys are accepted). Invalid entries are skipped; fields are normalized and control-character stripped, each formatted item truncates at 2,048 characters, collection stops at 50 items or before exceeding 65,536 characters, and a raw file above 262,144 characters lifts nothing.
- Timeout or abort sends SIGTERM with bounded SIGKILL escalation: Pi stages signal the direct child, while detached code stages signal the child process group.
- Pi's offline environment key and default kill-escalation duration are implementation constants, not public API. Tests pin their observable environment and timing behavior without importing those internals.

## Gotchas

- `projectRoot` is the exact child cwd; no executor creates or selects a worktree.
- The Pi emission key is per process and secret-like: pass it through the child environment but never emit it in events/debug logs.
- Upstream payload text is model-authored data, not trusted instructions or authenticated output for the invoked child; preserve the warning, dynamic fence, and provenance boundary together.
- Code execution is trusted local execution, not a sandbox, and interrupted commands may run again under at-least-once recovery.
- `findingsFile` is resolved from `projectRoot`, but RunDef validation currently checks only that it is nonempty; absolute paths and `..` traversal are not rejected, so pipeline YAML remains trusted configuration.

## Learnings

- 2026-08-14 — Literal no-shell argv and an exhaustive two-way dispatcher add deterministic local execution without exposing process-mechanism branching to the FSM.
- 2026-08-15 — Prompt-only StageHandoff can enrich successor reasoning without altering child spawn transport, emission provenance, or the existing findings summary.
- 2026-08-20 — Code-stage regression evidence needs a separate bounded, schema-marked file trust boundary; process diagnostics are not structured findings.
- 2026-08-25 — Strict production dead-code enforcement is most reliable when tests assert boundary behavior instead of turning implementation constants into accidental exports.
