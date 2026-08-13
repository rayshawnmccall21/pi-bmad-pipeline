# Plan: Add a deterministic `code` stage type

**Status:** approved; open decisions resolved. Implementation authorized on branch `feat/STY-112-code-stage-type`.
**Linear:** [STY-112](https://linear.app/stylepass/issue/STY-112/add-deterministic-kind-code-stage-type-to-pi-bmad-pipeline)

## Intent

**Question:** How should `pi-bmad-pipeline` run deterministic local commands alongside agent workflows without coupling the FSM to either execution mechanism?

**Recommendation:** add one closed `agent | code` stage union and one exhaustive two-way executor dispatcher. Keep the generic FSM, durable state, routing, and event protocol. Do not add a plugin registry.

**Assumption to confirm:** "code stage" means a trusted local executable plus literal argv, not inline TypeScript or a shell script string.

**Success:** an existing all-agent RunDef behaves unchanged, while a mixed RunDef can run a no-shell command, persist its lifecycle, and advance on exit `0` without requiring a BMAD envelope.

**Not covered:** untrusted YAML, sandboxing, shell interpolation, code payload gates, retry/regression on command failure, model-less code-only runs, or restoring worktrees.

## What exists today

### End-to-end flow

```text
.pi/bmad/pipelines/*.yaml
  -> YAML loader
  -> strict TypeBox schema + routing invariants
  -> compiler + payload-gate resolution
  -> canonical RunDef digest
  -> action creates one PiCliWorkflowExecutor for the run
  -> generic FSM calls executor.execute(stage)
  -> Pi argv contains --bmad-workflow, story, model, and thinking
  -> pi-bmad resolves the workflow/step effective agent
  -> authenticated HeadlessWorkflowOutput
  -> decision -> routing -> durable state -> JSONL events
```

```text
┌──────────────────────┐
│  *.yaml (RunDef)     │
└─────────┬────────────┘
          ▼
┌──────────────────────┐
│  loader (YAML parse) │
└─────────┬────────────┘
          ▼
┌──────────────────────┐     ┌───────────────────────┐
│  schema.ts (TypeBox) │────▶│ cross-field invariants │
└─────────┬────────────┘     └───────────────────────┘
          ▼
┌──────────────────────┐     ┌──────────────────┐
│  compile.ts          │────▶│ gate registry    │
└─────────┬────────────┘     └──────────────────┘
          ▼
┌──────────────────────┐
│  run-pipeline-action │  creates PiCliWorkflowExecutor
└─────────┬────────────┘
          ▼
┌──────────────────────┐
│  pipeline-runner FSM │  calls executor.execute(stage)
│  (stage-neutral)     │◀─── saveState after each transition
└─────────┬────────────┘
          ▼
┌──────────────────────┐
│ PiCliWorkflowExecutor│  spawns `pi` with --bmad-workflow
└─────────┬────────────┘
          ▼
┌──────────────────────┐
│  stage-decision.ts   │  requires BMAD output or fails
└─────────┬────────────┘
          ▼
┌──────────────────────┐
│  routing.ts          │  continue / regress / complete / fail
└─────────┬────────────┘
          ▼
   durable state + JSONL events
```

Load-bearing paths:

- `src/rundef/types.ts` — `StageKind` is currently only `"agent"`; raw and compiled stages require `workflow` and `agent`.
- `src/rundef/schema.ts` — runtime schema hard-codes `kind: Type.Literal("agent")`.
- `src/rundef/compile.ts` — copies `kind`, `workflow`, and `agent` without branching.
- `src/actions/run-pipeline-action.ts` — creates one run-wide `PiCliWorkflowExecutor`.
- `src/core/pipeline-runner.ts` — is already stage-mechanism-neutral and calls one injected executor.
- `src/executors/workflow-executor.ts` — existing narrow execution request/result seam.
- `src/executors/pi/build-stage-args.ts` — builds the agent-only Pi invocation.
- `src/core/stage-decision.ts` — currently requires validated BMAD output even when no payload gate exists.
- `src/core/routing.ts` — only `gate-failed` can regress through `onFail`; ordinary failures stop.
- `src/state/pipeline-state.ts` and `src/state/state-reconcile.ts` — key lifecycle and resume by stage ID, not executor type.

### What YAML `agent` actually means

There are two separate fields:

```yaml
kind: agent
agent: dev
```

- `kind: agent` is currently a schema/type discriminator in name only. Runtime code never branches on it.
- `agent: dev` is required and copied into the compiled stage, but no production code consumes it after compilation.
- Neither `kind` nor `agent` is included in Pi argv. `buildStageArgs()` passes `--bmad-workflow`, not `--bmad-agent`.
- pi-bmad activates `StepDef.agent ?? WorkflowDef.agent` when the workflow starts or advances. When `--bmad-workflow` is present, the workflow's effective agent is authoritative.

Therefore, the RunDef `agent` field is currently declarative metadata that can drift from the workflow. Preserve it for compatibility in this change, but do not reinterpret it as an executor selector. Removing it or validating it against pi-bmad discovery is separate work.

## Domain model

### Bounded contexts (Where)

This package has six bounded contexts. Every module has a `CONTEXT.md` that governs its responsibility, invariants, and public seams. **Read the governing CONTEXT.md before changing any module; update it before marking a slice green.**

```text
┌─ RunDef BC ──────────┐  ┌─ Execution BC ────────┐  ┌─ Observation BC ────┐
│  rundef/             │  │  core/                │  │  events/            │
│  (schema, compile,   │  │  (FSM, routing,       │  │  state/             │
│   identity, select)  │  │   decision, budgets)  │  │  (persistence,      │
│  gates/              │  │  executors/            │  │   reconciliation)   │
│  (payload eval)      │  │  (process boundary)   │  │                     │
└──────────────────────┘  └───────────────────────┘  └─────────────────────┘
┌─ Model BC ───────────┐  ┌─ Security BC ──────────┐
│  model/              │  │  security/             │
│  (config resolution) │  │  (redaction)           │
└──────────────────────┘  └────────────────────────┘
┌─ Composition Root (Anti-Corruption Layer) ───────────────────────────────┐
│  actions/  —  wires all BCs; owns lock → prepare → execute → settle     │
└──────────────────────────────────────────────────────────────────────────┘
```

### Type hierarchy (What)

New discriminated unions extend the RunDef aggregate:

```text
RunDefStage (raw YAML)
  ├── AgentRunDefStage   { kind: "agent", workflow, agent, ... }
  └── CodeRunDefStage    { kind: "code",  command, args?, ... }

CompiledStageDef (immutable, post-compilation)
  ├── CompiledAgentStage { kind: "agent", workflow, agent, resolvedGate }
  └── CompiledCodeStage  { kind: "code",  command, args: readonly string[] }

WorkflowExecutor (interface — name kept for compatibility)
  ├── PiCliWorkflowExecutor  implements WorkflowExecutor  (agent stages)
  └── LocalCodeExecutor      implements WorkflowExecutor  (code stages)
  └── StageExecutorDispatcher implements WorkflowExecutor  (exhaustive switch)

StageExecutionResult (value object — shared by both executors)
  └── new optional field: diagnostic?: string  (bounded, redacted failure text)
```

Both executors implement the existing `WorkflowExecutor` interface. The name is kept because renaming it would touch every consumer for no behavioral gain. The dispatcher is the only `WorkflowExecutor` the FSM sees.

### Domain rule change: `output: null` semantics (Why)

Today, `output: null` always means "no valid output was produced" and triggers `missing-output` failure. With code stages, this changes to kind-dependent:

- **Agent:** `output: null` remains a failure — authenticated BMAD output is required.
- **Code:** `output: null` is success — exit `0` is the only success signal; there is no payload to produce.

This is a semantic inversion for one kind. The `checkStageDecision` function already receives the full `CompiledStageDef` through `CheckStageDecisionRequest.stage`, so `kind` is available without adding a new parameter — the change is branching logic inside the existing function, not an interface change.

### Proposed code-stage end-to-end flow

```text
*.yaml (kind: code)                       *.yaml (kind: agent)
  │                                          │
  ▼                                          ▼
schema.ts ── CodeRunDefStage union         schema.ts ── AgentRunDefStage union
  │                                          │
  ▼                                          ▼
compile.ts ── freeze argv, skip gates      compile.ts ── resolve gates, copy agent
  │                                          │
  ▼                                          ▼
  └──────────────┬───────────────────────────┘
                 ▼
  run-pipeline-action.ts (composition root)
  creates StageExecutorDispatcher
                 │
                 ▼
  pipeline-runner FSM  (stage-kind-neutral)
                 │
                 ▼
  StageExecutorDispatcher.execute(stage)
      switch(stage.kind)
        │                    │
  kind: code           kind: agent
        │                    │
        ▼                    ▼
  LocalCodeExecutor    PiCliWorkflowExecutor
  (child_process,      (spawns pi with
   shell: false,        --bmad-workflow)
   env: process.env)
        │                    │
        ▼                    ▼
  StageExecutionResult (shared value object)
        │                    │
        ▼                    ▼
  stage-decision.ts
    code: exit 0 = passed (output: null)
    agent: requires BMAD output
        │
        ▼
  routing.ts (unchanged) → state → events
```

## Existing abstractions: reusable versus missing

### Reuse

- `WorkflowExecutor.execute(StageExecutionRequest)` is the shared executor interface. Both `PiCliWorkflowExecutor` and `LocalCodeExecutor` implement it. The `StageExecutorDispatcher` wraps both behind one instance.
- `StageExecutionResult` already carries exit code, duration, timeout, abort, and optional usage. A new optional `diagnostic` field carries bounded, redacted failure text for code stages.
- The injected `createExecutor` action seam can construct a dispatcher without teaching the FSM about process types.
- Core sequencing, persistence, bounded regressions, observer callbacks, and ID-only reconciliation are stage-kind-neutral.
- The RunDef digest automatically includes `kind`, `command`, and `args` because it hashes canonical raw YAML data.

### Required architecture changes

1. Replace monolithic stage types/schemas with strict agent/code discriminated unions.
2. Compile each variant explicitly and preserve immutable argv.
3. Make agent success continue to require authenticated BMAD output, but let code success use exit status.
4. Add a local process executor with a no-shell process contract.
5. Add one exhaustive dispatcher at the current executor seam.
6. Correct documentation that still says every stage is a Pi child or runs in an isolated worktree.

```text
                    ┌──────────────────────┐
                    │  pipeline-runner FSM  │
                    │  (stage-kind-neutral) │
                    └─────────┬────────────┘
                              │
                              ▼
                    ┌──────────────────────┐
                    │  stage-executor      │
                    │  dispatcher          │
                    │  (exhaustive switch) │
                    └───┬─────────────┬────┘
          kind: agent   │             │   kind: code
                        ▼             ▼
              ┌─────────────┐ ┌──────────────────┐
              │ PiCliWork-  │ │ LocalCodeExecutor │
              │ flowExecutor│ │ (child_process,   │
              │ (spawns pi) │ │  shell: false)    │
              └──────┬──────┘ └────────┬─────────┘
                     │                 │
                     ▼                 ▼
              ┌────────────────────────────────┐
              │   StageExecutionResult         │
              │   (shared exit/duration/usage)  │
              └──────────────┬─────────────────┘
                             ▼
              ┌────────────────────────────────┐
              │   stage-decision.ts            │
              │   agent: requires BMAD output  │
              │   code:  exit 0 = passed       │
              └──────────────┬─────────────────┘
                             ▼
              ┌────────────────────────────────┐
              │   routing.ts (unchanged)       │
              └────────────────────────────────┘
```

### Do not add

Do not add an executor registry, plugin API, dynamic stage loading, or a factory map. Two known kinds need one exhaustive `switch`. The repository already says "generalized plugin API" is deferred (`final-implementation-agent-plan.md`), and PR #2 deliberately removed unwired stage-extension plumbing.

The payload-gate registry is not an executor registry: it evaluates authenticated agent payloads after execution and should remain unchanged.

## Proposed v1 YAML contract

```yaml
id: verify-locally
stages:
  - id: implement
    kind: agent
    workflow: dev-story
    agent: dev
    timeout: 3600

  - id: check
    kind: code
    command: npm
    args: ["run", "check"]
    timeout: 1800
```

### Code-stage fields

Allowed:

- `id`
- `description`
- `kind: code`
- `command`: required nonblank executable/path
- `args`: optional string array; compiled to a frozen array
- `timeout`: existing positive-seconds contract

Rejected in v1:

- `workflow`, `agent`, `thinking`, `budget`
- `gate`, `onFail`, `maxRetries`
- `extensions`, `oPool`, `oName`, `oTag`
- `shell`, inline `script`, `cwd`, or YAML `env`

### Execution contract

- Spawn `command` with literal `args`; `shell: false`.
- Run in the request's `projectRoot`. Current code does not create a worktree; PR #4 deliberately removed that behavior.
- Ignore stdin and continuously drain stdout/stderr.
- Pass the parent's `process.env` to the child process. No allowlist, no fixed overrides.
- Retain at most the existing diagnostic cap (16,384 characters), redact it before it can enter a decision/state record, and discard successful output.
- Exit `0` passes with `output: null`; do not fabricate `{ payload: {} }`.
- Nonzero or null exit fails terminally. `onFail` regression is deliberately deferred because current `onFail` means payload-gate failure.
- Timeout fails; abort and spawn/setup errors require attention, matching current lifecycle categories.
- Use SIGTERM then bounded SIGKILL escalation on the process group (`detached: true`, `kill(-pid)`). No orphaned descendants survive timeout/abort.

### Trust and replay contract

A code stage is trusted repository code, not a sandbox. Explicit `bmad-pipeline run <id>` against a trusted checkout is the consent boundary — no additional `--allow-code` flag required. If RunDefs will be auto-run from untrusted branches, stop and design an invocation permission gate plus a real sandbox first.

Interrupted running stages are reconciled to pending, so code execution is at-least-once. Command authors must make mutating commands idempotent or externally keyed. "Deterministic" means no LLM decides the result; it does not mean exactly-once or reproducible across different hosts.

The RunDef digest covers command and argv changes. It does not cover referenced script contents, executables, dependencies, lockfiles, or host `PATH`; agent workflow contents are similarly outside today's digest.

```text
     reconcile          FSM loop            timeout/abort
         │                  │                    │
         ▼                  ▼                    ▼
  ┌──────────────┐   ┌─────────────┐   ┌──────────────────┐
  │   pending    │──▶│   running   │──▶│ SIGTERM ─► SIGKILL│
  └──────────────┘   └──────┬──────┘   │ (process group)  │
         ▲                  │          └────────┬─────────┘
         │          ┌───────┴────────┐           │
  (interrupted      │                │           │
   recovery)  exit 0│          exit≠0│      timed-out/
         │          ▼                ▼      aborted
         │   ┌────────────┐  ┌────────────┐     │
         │   │   passed   │  │   failed   │◀────┘
         │   │(output:null│  │ (terminal  │
         │   │ for code)  │  │  in v1)    │
         │   └────────────┘  └────────────┘
         │
  ┌──────────────┐
  │  crash/kill: │
  │  running ──▶ │
  │  pending     │  (at-least-once; commands must be idempotent)
  └──────────────┘
```

```text
 ┌─ TRUST BOUNDARY ─────────────────────────────────┐
 │                                                   │
 │  RunDef YAML (.pi/bmad/pipelines/*.yaml)          │
 │  projectRoot (cwd for child process)              │
 │  Full process.env (inherited from parent)         │
 │  command + literal args (shell: false)             │
 │  Explicit run <id> = consent (no --allow-code)    │
 │                                                   │
 └───────────────────────────────────────────────────┘

 ╳ OUTSIDE (not available to code stages in v1)
   • shell interpolation (no shell)
   • YAML-defined env / cwd override
   • network sandbox / filesystem isolation
   • worktree isolation (removed in PR #4)
   • untrusted RunDef execution (requires separate design)
```

## Architectural decisions

| Decision             | Choice                                           | Why                                                                                                                   | Why not the alternative                                                                                                                 |
| -------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Stage model          | Closed `agent \| code` union                     | Strict invalid-field rejection and exhaustive compilation                                                             | Open union/string kind: loses compile-time exhaustiveness; unknown kinds slip through to runtime                                        |
| Executor composition | One two-way dispatcher behind `WorkflowExecutor` | Reuses the existing effect boundary; keeps core sequencing generic                                                    | Executor registry/plugin map: only two kinds exist; registry adds indirection for no demonstrated need (PR #2 removed similar plumbing) |
| Code success         | Kind-aware exit-code success                     | Avoids forging a BMAD payload and preserves agent provenance rules                                                    | Fabricate `{ payload: {} }`: conflates code output with authenticated agent output; breaks provenance guarantees                        |
| Code failure routing | Terminal in v1                                   | Avoids changing established payload-gate/`onFail` semantics and unsafe replay loops                                   | `onCodeFail` field: `onFail` currently means payload-gate failure only; overloading it silently changes behavior for existing configs   |
| Command syntax       | Executable + argv, no shell                      | Prevents shell interpolation; command-specific option boundaries still need validation (see `earendil-works/pi#4018`) | Shell string: introduces injection class and quoting ambiguity                                                                          |
| Cwd                  | Exact `projectRoot`                              | Matches current implementation and PR #4; no pretend isolation                                                        | Per-stage cwd: no demonstrated need; adds a path-resolution surface with no isolation guarantee                                         |
| Output               | Bounded, redacted failure diagnostic only        | Keeps failures operable without persisting unbounded/raw output                                                       | Full stdout capture: unbounded; quadratic handling risk per `pi#4145`                                                                   |
| State/events         | Keep existing wire shapes                        | Stage state is already generic; no consumer requires `stageKind` yet                                                  | Add `stageKind` to state/events: migration cost for zero demonstrated consumer                                                          |
| Model config         | Preserve current run-level requirement           | Avoids a wider state/resume migration for code-only pipelines                                                         | Skip model for code-only runs: changes resume identity contract; separate work                                                          |
| Extensibility        | No plugin registry                               | Rule of three has not been met                                                                                        | Build registry now: premature; PR #2 already removed unwired version                                                                    |

## Resolved decisions

All five open questions have been resolved:

| #   | Decision         | Resolution                                          | Rationale                                                                                                                                      |
| --- | ---------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | First use case   | `npm run check`                                     | The pipeline's own quality gate — typecheck, lint, format, coverage, CRAP, E2E. No LLM needed. Walking skeleton proves the feature end-to-end. |
| 2   | Permission model | Implicit — `run <id>` is consent                    | The YAML is in a trusted repo; the user explicitly chose the pipeline. Agent stages already run arbitrary code. No `--allow-code` flag.        |
| 3   | Environment      | Pass full `process.env`                             | No allowlist, no fixed overrides. The child sees everything the parent sees.                                                                   |
| 4   | Diagnostics      | Save bounded, redacted failure diagnostics in state | Max 16KB, secrets scrubbed. Knowing why a stage failed without re-running it is worth the small disk cost.                                     |
| 5   | Process tree     | Kill whole process group                            | `detached: true` + `kill(-pid)`. No orphaned descendants after timeout/abort.                                                                  |

## Red/green implementation plan

### Slice 1 — Strict stage unions

**Where:** `src/rundef/` (RunDef bounded context)
**What:** Discriminated `agent | code` stage unions in types, schema, and compiler.
**Why:** Strict per-kind field validation prevents invalid field combinations at parse time. Exhaustive compilation rejects unknown kinds at compile time. This is the aggregate root — every downstream consumer inherits the guarantee.
**How:** TypeBox `Type.Union` with `kind` discriminator; exhaustive `switch` in `compileStage`.

**Read first:** `src/rundef/CONTEXT.md`

**RED**

Add tests in:

- `src/rundef/schema.test.ts`
- `src/rundef/loader.test.ts`
- `src/rundef/compile.test.ts`

Prove:

- minimal and mixed code stages validate;
- missing/blank command and non-string args fail;
- agent-only fields on code fail closed;
- unknown kinds fail;
- existing agent stages retain the same compiled shape;
- code args are copied/frozen and input is not mutated.

**GREEN**

Change:

- `src/rundef/types.ts`
- `src/rundef/schema.ts`
- `src/rundef/compile.ts`
- `src/rundef/index.ts`

Introduce `AgentRunDefStage | CodeRunDefStage` and corresponding compiled variants. Preserve `RunDefStage`, `StageDef`, and `CompiledStageDef` exports. Compile through an exhaustive kind switch; resolve payload gates only for agent stages.

**Update docs:** Update `src/rundef/CONTEXT.md` invariants to reflect the discriminated union and kind-specific validation rules. Do not defer to Slice 6 — a stale CONTEXT.md between slices gives wrong guidance.

### Slice 2 — Honest success semantics

**Where:** `src/core/` (Execution BC) and `src/executors/workflow-executor.ts` (type contract)
**What:** Kind-aware decision evaluation; new optional `diagnostic` field on `StageExecutionResult`.
**Why:** Agent success requires authenticated BMAD output; code success is exit `0` with `output: null`. Without branching on `kind`, code stages would always fail as `missing-output`. The `diagnostic` field carries bounded, redacted failure text so code failures are operable without persisting raw output.
**How:** `checkStageDecision` already receives `stage: CompiledStageDef` in `CheckStageDecisionRequest`, so `stage.kind` is available — no new parameter needed. Add branching logic inside `checkStageDecision` to treat `output: null` as success for `kind: "code"`. Add `diagnostic?: string` to `StageExecutionResult` (the value object shared by all executors). The `workflow-executor.ts` change is type-only: adding the optional field to the result interface.

**Read first:** `src/core/CONTEXT.md`, `src/executors/CONTEXT.md`

**RED**

Add tests in:

- `src/core/stage-decision.test.ts`
- `src/core/runner-evaluation.test.ts`

Prove:

- agent exit `0` still fails without authenticated output;
- code exit `0` passes with `output: null`;
- nonzero/null exit, timeout, and abort remain typed failures;
- only a bounded, pre-redacted code diagnostic can enter a failure reason.

**GREEN**

Change:

- `src/core/stage-decision.ts` — add kind-aware branch in `checkStageDecision`
- `src/core/runner-evaluation.ts` — propagate diagnostic into decision output
- `src/executors/workflow-executor.ts` — type-only: add optional `diagnostic` field to `StageExecutionResult`

Keep the existing agent decision order byte-behavior compatible. Do not change routing or durable status vocabularies.

**Update docs:** Update `src/core/CONTEXT.md` to note that stage kind influences decision evaluation (the `output: null` semantic change).

### Slice 3 — Local code executor

**Where:** new `src/executors/code/` module (Execution BC, infrastructure adapter)
**What:** `LocalCodeExecutor` implementing `WorkflowExecutor` for `kind: "code"` stages.
**Why:** Code stages need a no-shell child process executor with timeout/abort and bounded output. This is a new infrastructure adapter alongside `executors/pi/`, not a change to core domain logic.
**How:** Reimplement the timeout → SIGTERM → SIGKILL escalation pattern from `executors/pi/run-bmad-stage.ts` (specifically `killWithEscalation`, `attachChildHandlers`, `resolveTimeoutMs`). This is pattern reuse (copy), not extraction — extracting a shared module is premature with only two consumers and different draining logic (JSONL parsing vs raw output). Mark the duplication ceiling with a `ponytail:` comment. Use `detached: true` and `kill(-pid)` for process-group termination.

New module follows established pattern: barrel `index.ts`, own `CONTEXT.md`, imports types only from `../rundef/` and `../security/`.

**Read first:** `src/executors/CONTEXT.md`, `src/executors/pi/run-bmad-stage.ts` (timeout/abort shape)

**RED**

Add `src/executors/code/local-code-executor.test.ts` covering:

- exact executable, argv, cwd, `shell: false`, ignored stdin, and full `process.env`;
- exit `0`, nonzero, null exit, sync/async spawn errors;
- timeout, already-aborted and mid-flight abort, process-group escalation, and descendant cleanup;
- output draining, cap, redaction, and successful-output discard;
- duration and wrong-stage-kind rejection.

**GREEN**

Add:

- `src/executors/code/local-code-executor.ts`
- `src/executors/code/index.ts`

Use Node stdlib only. Pi and code executors must each reject the wrong stage kind.

**Create docs:** Create `src/executors/code/CONTEXT.md` with responsibility ("Local process executor for deterministic code stages"), invariants (shell: false, process.env inherited, bounded output, process-group termination), and dependencies (rundef types, security redaction). Follow the template used by `src/executors/CONTEXT.md`.

### Slice 4 — Exhaustive dispatch and action wiring

**Where:** `src/executors/stage-executor-dispatcher.ts` (Execution BC) and `src/actions/` (Composition Root)
**What:** `StageExecutorDispatcher` implementing `WorkflowExecutor`.
**Why:** The FSM must see one executor; the dispatcher hides kind-awareness from core.
**How:** `StageExecutorDispatcher` wraps `PiCliWorkflowExecutor` + `LocalCodeExecutor` and dispatches via exhaustive `switch (stage.kind)`. Constructed in `run-pipeline-execution.ts` where executor options are prepared alongside model/thinking.

**Read first:** `src/actions/CONTEXT.md`, `src/executors/CONTEXT.md`

**RED**

Add tests in:

- new `src/executors/stage-executor-dispatcher.test.ts`
- `src/executors/pi/pi-cli-executor.test.ts`
- `src/actions/run-pipeline-action.test.ts`

Prove agent requests only reach Pi, code requests only reach the local executor, and a code-only action does not spawn Pi.

**GREEN**

Add/change:

- new `src/executors/stage-executor-dispatcher.ts`
- `src/executors/index.ts`
- `src/actions/run-pipeline-action.ts`
- `src/actions/run-pipeline-execution.ts`

Construct exactly two delegates and dispatch with an exhaustive switch. Preserve the existing injected `createExecutor` seam and current model/thinking preparation.

**Update docs:** Update `src/executors/CONTEXT.md` responsibility from "Process boundary executing one compiled stage in a fresh hermetic Pi child" to cover both executor types and the dispatcher. Update `src/actions/CONTEXT.md` to document dispatcher construction in the composition root.

### Slice 5 — Mixed lifecycle, security, and resume

**Where:** Cross-module integration tests across `core/`, `actions/`, `state/`, `tests/e2e/`
**What:** End-to-end verification that mixed agent+code pipelines sequence, persist, reconcile, and redact correctly.
**Why:** Individual slices test each module in isolation. This slice proves they compose correctly across BC boundaries and that existing agent-only behavior is unchanged.
**How:** Integration tests with mixed RunDef fixtures. Expected module-boundary fixes are limited to: state reconciliation (if `kind` needs threading), event emission (if diagnostic field flows to JSONL), and redaction (if code output introduces new patterns). `core/`, `model/`, `gates/`, and `security/` should NOT need changes — if they do, the isolation from earlier slices was wrong.

**Read first:** `src/state/CONTEXT.md`, `src/core/CONTEXT.md`, `src/events/CONTEXT.md`, `src/security/CONTEXT.md`

**RED**

Extend:

- `src/core/pipeline-runner.test.ts`
- `src/actions/run-pipeline-action.test.ts`
- `src/state/state-reconcile.test.ts`
- `tests/e2e/fsm-routing.test.ts`
- `tests/e2e/child-boundary.test.ts`
- `tests/e2e/redaction.test.ts`
- `tests/e2e/state-recovery.test.ts`

Prove:

- mixed stages execute and persist in order;
- exit `0` advances and nonzero stops without regression;
- timeout/abort/spawn outcomes are durable and emit a terminal lifecycle signal;
- invalid code YAML fails before any child starts;
- interrupted code stages reconcile to pending and rerun;
- changing command/args rejects resume through RunDef identity;
- no credential-shaped diagnostic reaches durable state or JSONL;
- current all-agent built-CLI behavior remains unchanged.

**GREEN/REFACTOR**

Make only the smallest cross-module fixes exposed by those tests. Do not add code payload gates, retries, event variants, or state fields.

### Slice 6 — Authoring and boundary documentation

**Where:** Package-wide documentation sweep.
**What:** Final evergreen pass — verify all CONTEXT.md files and public docs reflect the code-stage feature.
**Why:** Earlier slices update CONTEXT.md incrementally as modules change. This slice catches anything missed, adds public-facing authoring guidance, and verifies documentation freshness tests.
**How:** Topic-to-file mapping below.

Update after behavior is green:

| File                                         | Topic                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CONTEXT.md`                                 | Add code stage to core flow diagram; add `executors/code/` to module boundary list; update child boundary section                                                  |
| `README.md`                                  | Add `kind: code` YAML example alongside `kind: agent`                                                                                                              |
| `src/rundef/CONTEXT.md`                      | Verify Slice 1 update covers discriminated union; add any missed invariants                                                                                        |
| `src/executors/CONTEXT.md`                   | Verify Slice 4 update covers both executor types and dispatcher                                                                                                    |
| `src/core/CONTEXT.md`                        | Verify Slice 2 update covers kind-aware decision                                                                                                                   |
| `src/actions/CONTEXT.md`                     | Verify Slice 4 update covers dispatcher construction                                                                                                               |
| `skills/pi-bmad-pipeline-workflows/SKILL.md` | Add code stage authoring rules (no `agent` field, required `command`); update the "Rules" section that currently says "set required `agent` to the workflow owner" |
| `src/docs-freshness.test.ts`                 | Verify new vocabulary does not trip existing checks; add code-stage vocabulary checks if appropriate                                                               |
| `src/quality-scripts.test.ts`                | Add temporary code fixture to validator tests                                                                                                                      |

**No CONTEXT.md updates needed for:** `src/model/`, `src/state/`, `src/gates/`, `src/security/`, `src/events/` — confirm these modules were not changed.

### Slice 7 — Gates

Run focused tests after each green slice, then:

```bash
npm run check
```

The full gate covers typecheck, formatting, lint, coverage, CRAP, checkpoint conformance, E2E, and dead code.

## Evergreen documentation contract

Every module under `src/` has a `CONTEXT.md` with sections: Responsibility, Invariants, Public seams, Dependencies, Gotchas/Learnings. This plan requires:

1. **Read before change:** Each slice lists a "Read first" section naming the CONTEXT.md files that govern the modules being touched.
2. **Update with change:** When a slice changes a module's invariants or public seams, update that module's CONTEXT.md in the same slice — not deferred to Slice 6.
3. **Create for new modules:** `src/executors/code/CONTEXT.md` must be created in Slice 3.
4. **Verify after all slices:** Slice 6 sweeps all CONTEXT.md files and public docs for anything missed.
5. **Test freshness:** `src/docs-freshness.test.ts` enforces that docs do not contain deleted vocabulary. Verify new terms do not trip existing checks.

## Acceptance criteria

- [ ] Existing `kind: agent` YAML compiles and runs unchanged.
- [ ] `agent` metadata is preserved but is not treated as executor selection.
- [ ] Invalid or mixed-shape code stages fail before a process starts.
- [ ] Code commands use literal argv, no shell, fixed project-root cwd, full `process.env`, and bounded/redacted diagnostics.
- [ ] Exit `0` passes without a BMAD envelope; agent stages still require authenticated output.
- [ ] Nonzero code exit stops the run in v1; it does not silently enter agent gate routing.
- [ ] Timeout/abort terminates the process group and records the attempt.
- [ ] Interrupted code stages have documented at-least-once replay behavior.
- [ ] Command/args changes invalidate resume through the existing digest.
- [ ] State and public JSONL schemas remain compatible.
- [ ] No executor/plugin registry or new dependency is introduced.
- [ ] All module CONTEXT.md files updated (evergreen documentation contract).
- [ ] `npm run check` passes.

## Related Linear work

Linear searches found no issue explicitly for `pi-bmad-pipeline` or a YAML code stage.

| Ticket                                                                                                                     | Status   | Relationship                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [STY-8](https://linear.app/stylepass/issue/STY-8/pipeline-runner-type-abstraction-goal-loop-executor-async-dispatch)       | Backlog  | Closest competing architecture: a pipeline-level `type` selects an executor, and deterministic Bash gates drive an agent retry loop. Decide whether stage-level `kind: code` should replace, complement, or avoid this broader goal-loop design. |
| [STY-80](https://linear.app/stylepass/issue/STY-80/deterministic-seedteardown-execution-for-qa-requirement-loop-remove)    | Canceled | Close match: removing LLMs from deterministic seed/teardown. It was superseded by STY-86 because keeping the logic in the expert package was judged a half-measure.                                                                              |
| [STY-86](https://linear.app/stylepass/issue/STY-86/move-all-seedteardown-logic-from-supabase-expert-to-qa-python-strip-db) | Done     | Completed successor to STY-80: deterministic Python owns seed/teardown directly and removes those mutating tools from the expert.                                                                                                                |
| [STY-76](https://linear.app/stylepass/issue/STY-76/qa-failure-setup-infra-e4-45-hp2-subscription-grandfathering-setup)     | Backlog  | Concrete failure caused by LLM-mediated deterministic setup; STY-80/STY-86 address its root execution path.                                                                                                                                      |
| [STY-25](https://linear.app/stylepass/issue/STY-25/build-qa-impl-orchestratorpy-deterministic-python-orchestrator-10)      | Done     | Precedent for a deterministic orchestrator that runs commands/gates and spawns agents.                                                                                                                                                           |
| [STY-18](https://linear.app/stylepass/issue/STY-18/build-pipeline-gatests-quality-gate-extension)                          | Done     | Precedent for deterministic typecheck/lint/test gates, but at extension/tool level rather than as RunDef stage types.                                                                                                                            |
| [STY-31](https://linear.app/stylepass/issue/STY-31/build-qa-determinism-checksh-standalone-determinism-verification)       | Done     | Precedent for reusable exit-code-based deterministic checks.                                                                                                                                                                                     |

Potential conflict: STY-8 proposes the same deterministic-gate goal at pipeline granularity, while STY-18, STY-25, and STY-86 already provide deterministic execution in another QA stack. Before implementing, choose the ownership boundary and name at least one command that must be first-class here rather than invoked by those systems or an existing BMAD workflow.

## Related GitHub work

### This repository

Verified through the GitHub API:

- There are **zero GitHub issues** in `rayshawnmccall21/pi-bmad-pipeline`; no exact match or explicit rejection exists.
- [PR #2](https://github.com/rayshawnmccall21/pi-bmad-pipeline/pull/2), merged 2026-08-06, narrowed the product to its Unix core and removed unwired stage-extension plumbing. This conflicts with a generalized plugin design, not with one small built-in process executor.
- [PR #4](https://github.com/rayshawnmccall21/pi-bmad-pipeline/pull/4), merged 2026-08-10, deliberately removed worktree isolation. Code stages must not claim isolation.
- [PR #7](https://github.com/rayshawnmccall21/pi-bmad-pipeline/pull/7), merged 2026-08-13, added utility-pipeline support without required story/spec arguments. This is adjacent support for future code-oriented pipelines, though model and default thinking remain run-level/state identity while agent stages may override thinking.
- [Commit `ad0c74e`](https://github.com/rayshawnmccall21/pi-bmad-pipeline/commit/ad0c74e869336fc710d72963f3b365e0e6b70c4a), 2026-08-11, re-added explicit per-stage Pi extensions. It is an agent-stage capability and not an executor-type abstraction; it also conflicts with stale docs that claim exactly one extension.

### Predecessor/orchestrator

- [pi-orchestrator issue #15](https://github.com/rayshawnmccall21/pi-orchestrator/issues/15) is open and asks for package-specific YAML pipelines.
- [pi-orchestrator PR #39](https://github.com/rayshawnmccall21/pi-orchestrator/pull/39), merged 2026-06-13, introduced RunDef schema/compiler, per-stage extensions, and gate registry. It is the strongest local architecture precedent.
- [pi-orchestrator PR #47](https://github.com/rayshawnmccall21/pi-orchestrator/pull/47), merged 2026-08-01, found that a `kind: gate` stage compiled into a nonexistent workflow named `review`; it was replaced with an agent stage using the real `code-review` workflow. This directly warns against schema-only stage kinds without explicit end-to-end dispatch tests.
- [pi-orchestrator issue #13](https://github.com/rayshawnmccall21/pi-orchestrator/issues/13) is open and requires recovery execution to use the same state-apply path. A code executor should stay behind the current FSM path, not mutate state itself.
- [pi-orchestrator issue #28](https://github.com/rayshawnmccall21/pi-orchestrator/issues/28) is closed and documents failed attempts contaminating retries with uncommitted changes. This risk is larger now that PR #4 removed worktrees.
- [pi-orchestrator issue #36](https://github.com/rayshawnmccall21/pi-orchestrator/issues/36) is open and shows why deterministic gates must not trust agent-authored evidence. Code stages help only if their result remains supervisor-owned and fail-closed.

### Pi process precedents

- [`earendil-works/pi#4018`](https://github.com/earendil-works/pi/issues/4018), closed 2026-04-30, demonstrates application-level argv/flag injection becoming RCE even without a shell. No-shell execution prevents shell interpolation, but command-specific option boundaries still require validation or `--` where supported.
- [`earendil-works/pi#4145`](https://github.com/earendil-works/pi/issues/4145), closed 2026-05-04, documents quadratic handling of chatty Bash output; this supports continuous draining with a strict retained-output cap.
- [`earendil-works/pi#3786`](https://github.com/earendil-works/pi/issues/3786), closed 2026-04-27, documents Bash executor file-descriptor leakage; code executor cleanup needs repeated-run coverage.

## Deferred follow-ups

Add only after a demonstrated use case:

- nonzero-exit `onFail` regression or typed code payload gates;
- per-stage cwd/env or shell scripts;
- referenced-script/dependency hashing;
- model-less code-only state;
- worktree restoration or a sandbox;
- new event/state fields;
- a third stage kind and executor registry.
