# pi-bmad-pipeline — Project Context

## 1. Architecture Overview

### The Three-Package Boundary

**pi-bmad** (`github.com/rayshawnmccall21/pi-bmad`)
Owns the in-process BMAD workflow runtime: WorkflowEngine, WorkflowDef, StepDef, ConditionalStepRoute, workflow YAML definitions, JSON Schema result payloads, headless output contracts, and contract validators. This package runs **inside** the spawned child process — it is the thing being supervised.

**pi-bmad-pipeline** (`github.com/rayshawnmccall21/pi-bmad-pipeline`) — THIS PACKAGE
Owns durable cross-process SDLC pipeline supervision: RunDef loading/compilation, stage spawning, JSONL parsing, payload gates, routing/regression, worktrees, budgets/timeouts, harness-owned evidence, PR/merge logic, audit, dispatch locks, and credential redaction. This package is the **trusted supervisor** that spawns fresh child processes and does not trust them.

**pi-orchestrator** (`github.com/rayshawnmccall21/pi-orchestrator`)
Shrinks to a thin Pi extension wrapper (~50 lines) that shells out to the `bmad-pipeline` CLI. It owns only Pi tool registration and progress forwarding.

### Trust Boundary Rationale

The supervisor must NOT live inside pi-bmad because pi-bmad is the extension loaded **inside** the supervised child process. The runner needs to say: "I do not trust the agent child. I do not trust its claims. I only trust validated headless output, harness-owned evidence, durable state, and my own gates." That is impossible when the supervisor is packaged as part of the same extension runtime it supervises.

### Dependency Direction

```
pi-bmad
  └── no dependency on pi-bmad-pipeline
  └── no dependency on pi-orchestrator

pi-bmad-pipeline
  └── imports pi-bmad/contracts (validateHeadlessWorkflowOutput, resolveExpectedReturnType, HEADLESS_WORKFLOW_SCHEMA_VERSION)
  └── shells out to pi as an opaque binary via child_process.spawn
  └── does NOT import WorkflowEngine, SessionManager, or any Pi runtime API
  └── does NOT import pi-bmad/src/internal

pi-orchestrator
  └── spawns bmad-pipeline CLI
  └── does NOT own the runner, state, worktrees, gates, or merge logic
```

### Execution Path

```
pi-orchestrator (Pi tool wrapper)
  └── spawn bmad-pipeline CLI
        └── acquire per-story lock
        └── load/reconcile durable state
        └── create/use git worktree
        └── compile RunDef → StageDef[]
        └── for each stage:
              └── spawn fresh pi child process
                    └── pi loads pi-bmad extension
                    └── pi-bmad runs one WorkflowDef
                    └── child emits HeadlessWorkflowOutput JSONL
              └── bmad-pipeline gates the terminal envelope (gateHeadlessTerminalOutput + emission key)
              └── bmad-pipeline evaluates payload gate
              └── bmad-pipeline routes/regresses/continues
        └── run harness evidence (test/typecheck/lint)
        └── open PR / gate merge / audit
```

## 2. Module Layout

```
pi-bmad-pipeline/
  src/
    cli.ts                        # CLI entry point (bin/bmad-pipeline)
    index.ts                      # Public barrel exports
    meta.ts                       # Package identity constants

    actions/
      run-pipeline-action.ts      # The clean callable: runPipelineAction()

    rundef/
      schema.ts                   # TypeBox RunDef schema + cross-field invariants
      types.ts                    # StageDef, PayloadGateResult, StageBudget, PayloadGate
      compile.ts                  # RunDef → StageDef[] compilation
      loader.ts                   # Discovers .pi/bmad/pipelines/*.yaml
      selector.ts                 # Builtin vs discovered resolution
      builtin.ts                  # SDLC_RUNDEF definition + resolveRunDef()
      registry.ts                 # Payload gate registry (module-level Map)
      ext-resolve.ts              # Stage extension path resolution

    core/
      pipeline-runner.ts          # The FSM main loop
      stage-decision.ts           # checkGate() evaluation
      routing.ts                  # Regression routing, onFail handling
      budgets.ts                  # Run-level budget gate
      timeouts.ts                 # Stage timeout constants

    gates/
      payload-gate.ts             # PayloadGate interface + PayloadGateRegistry
      bmad-gates.ts               # e2eVerifyPayloadGate, codeReviewPayloadGate

    executors/
      workflow-executor.ts        # WorkflowExecutor interface
      pi/
        pi-cli-executor.ts        # PiCliWorkflowExecutor implements WorkflowExecutor
        build-stage-args.ts       # buildStageArgs() — real pi headless argv + emission env
        run-bmad-stage.ts         # runBmadStage() — spawn wrapper with JSONL parsing
        headless-jsonl-parser.ts  # Stream-parse child stdout JSONL
        headless-stream-output.ts # Emission-gated terminal envelope extraction + usage
        pi-bmad-extension.ts      # Resolves the pi-bmad extension file for `pi -e`
        stage-debug-events.ts     # stage.spawn / stage.envelope-gate debug events

    contracts/
      workflow-contract-provider.ts  # WorkflowContractProvider interface
      bmad-contract-provider.ts      # BmadWorkflowContractProvider (wraps pi-bmad/contracts)

    state/
      pipeline-state.ts           # PipelineState, StageState types
      fs-state-store.ts           # State persistence to .pi/pipeline/state/<id>.json
      current-run-store.ts        # Current-run pointer (.pi/pipeline/state/current-run.json)
      dispatch-lock.ts            # Per-story mkdir-atomic dispatch lock
      state-reconcile.ts          # Crash recovery, contradiction repair

    git/
      worktrees.ts                # Git worktree isolation
      story-pull-request.ts       # PR opening, gh CLI, secret scanning
      merge-gate.ts               # Default-branch merge gate

    security/
      harness-evidence.ts         # HS-1: harness-owned test/typecheck/lint evidence
      redaction.ts                # Credential pattern redaction

    audit/
      audit-pipeline-run.ts       # Pipeline audit report generation

    events/
      debug-log.ts                # BMAD_PIPELINE_DEBUG structured stderr debug seam
      pipeline-event.ts           # (planned) PipelineCliEvent types (JSONL event protocol)

    model/
      model-config.ts             # 5-source model resolution + pre-spawn validation
```

## 3. RunDef vs WorkflowDef — Why They Must Stay Separate

**WorkflowDef** (pi-bmad, in-process, single agent, one session):

- Routes on BmadState fields (shared in-memory state, same process)
- Steps have checkpoints (code-evaluated definition-of-done gates)
- `ConditionalStepRoute` reads a dot-path from BmadState and routes to a different step
- Executed by WorkflowEngine inside the spawned child process

**RunDef** (pi-bmad-pipeline, cross-process, multiple agents, separate sessions):

- Routes on payload verdicts from SEPARATE PROCESSES (parses child stdout JSONL)
- Stages have `payloadGate` functions that evaluate `HeadlessWorkflowOutput.payload`
- `onFail` + gate route = the branching mechanism
- Executed by the pipeline FSM outside the child process

These are **different control planes**. WorkflowDef reads shared memory. RunDef parses child process stdout. Merging them would be an architectural error.

## 4. Key Interfaces

### WorkflowExecutor (the executor boundary)

```typescript
interface WorkflowExecutor {
  readonly id: string;
  execute(request: StageExecutionRequest): Promise<StageExecutionResult>;
}

interface StageExecutionRequest {
  stage: CompiledStageDef;
  storyId: string;
  specFile: string;
  projectRoot: string;
  worktreeCwd: string;
  attempt: number;
  priorFindings?: string[];
  signal: AbortSignal;
}

interface StageExecutionResult {
  output: HeadlessWorkflowOutput<unknown> | null;
  exitCode: number | null;
  durationMs: number;
  parseError?: string;
  usage?: { tokens: number; dollars: number };
  timedOut?: boolean;
  aborted?: boolean;
}
```

The pipeline FSM depends on `WorkflowExecutor`, not Pi. `PiCliWorkflowExecutor` is the only place that knows how to invoke pi.

### WorkflowContractProvider

```typescript
interface WorkflowContractProvider {
  resolveExpectedReturnType(workflow: string): string;
  validateHeadlessOutput(
    candidate: unknown,
    expected: { workflow: string; returnType: string },
  ): HeadlessWorkflowOutputValidationResult;
}
```

`BmadWorkflowContractProvider` wraps pi-bmad/contracts — the ONLY module that imports pi-bmad.

### PayloadGateRegistry

```typescript
type PayloadGate = (payload: Record<string, unknown>) => PayloadGateResult;

interface PayloadGateRegistry {
  resolve(name: string): PayloadGate | undefined;
}
```

### PipelineState

```typescript
interface PipelineState {
  storyId: string;
  specFile: string;
  worktreePath: string;
  branch: string;
  runnerFeatureVersion: number;
  status:
    | "pending"
    | "running"
    | "done"
    | "failed"
    | "needs-approval"
    | "paused"
    | "pr-opened"
    | "needs-attention";
  currentStage: string | null;
  stages: Record<string, StageState>;
  regressions: number;
  startedAt: string | null;
  finishedAt: string | null;
  model: string;
  thinking: string;
  economics: RunEconomicsSummary;
}
```

### RunResult

```typescript
interface RunResult {
  storyId: string;
  specFile: string;
  action: string;
  status: "passed" | "failed" | "needs-approval" | "paused" | "pr-opened" | "needs-attention";
  stagesRun: string[];
  regressions: number;
  durationMs: number;
  error?: string;
  worktreePath?: string;
  branch?: string;
  prUrl?: string;
  prNumber?: number;
  economics?: RunEconomicsSummary;
}
```

## 5. Migration Plan

### Phase 1: Create pi-bmad-pipeline package (DONE)

- Scaffolded from pi-package-template
- Strict quality gates: CRAP ≤ 5, coverage ≥ 90%, strict ESLint
- Empty directory structure ready

### Phase 2: Move RunDef subsystem (rundef/)

Move from pi-orchestrator/pipeline-runner/rundef/:

- `schema.ts` (234 lines) — TypeBox RunDef schema + cross-field invariants
- `types.ts` (36 lines) — StageDef, PayloadGateResult, PayloadGate, StageBudget
- `compile.ts` (172 lines) — RunDef → StageDef compilation
- `loader.ts` (141 lines) — Discovers .pi/bmad/pipelines/*.yaml
- `selector.ts` (133 lines) — Builtin vs discovered resolution
- `builtin.ts` (123 lines) — SDLC_RUNDEF + resolveRunDef()
- `registry.ts` (38 lines) — Payload gate registry
- `ext-resolve.ts` (66 lines) — Stage extension path resolution

### Phase 3: Move state subsystem

- `state-reconcile.ts` (221 lines) — Crash recovery, contradiction repair
- PipelineState types from runner.ts
- Dispatch lock logic from runner.ts
- State persistence (loadState, saveState) from runner.ts

### Phase 4: Move budget subsystem

- `stage-budget.ts` (112 lines) — Per-stage spend ceiling
- Budget gate from runner.ts

### Phase 5: Move model config

- `model-config.ts` (271 lines) — 5-source model resolution

### Phase 6: Move payload gates + gate evaluation

- e2eVerifyPayloadGate, codeReviewPayloadGate from runner.ts
- checkGate() from runner.ts

### Phase 7: Move executor (spawn wrapper)

- buildStageArgs from runner.ts
- runBmadStage from runner.ts
- JSONL stream parsing logic from runner.ts

### Phase 8: Move security-critical code

- `harness-evidence.ts` (883 lines) — HS-1 harness-owned evidence
- Credential redaction patterns from runner.ts

### Phase 9: Move git/PR logic

- `story-pull-request.ts` (1,002 lines) — Git worktree, PR, secret scanning
- Merge gate logic from runner.ts

### Phase 10: Move the FSM + runPipelineAction

- The FSM main loop from runner.ts
- runPipelineAction callable
- Audit report generation

### Phase 11: Add CLI entry point

- `bmad-pipeline run sdlc --story-id ... --spec-file ... --jsonl`
- Event protocol (PipelineCliEvent JSONL)

### Phase 12: Replace pi-orchestrator internals

- Delete the 9,104-line runner from pi-orchestrator
- Replace with CLI invocation wrapper

## 6. Architectural Invariants (Non-Negotiable)

1. **Hermetic isolation**: each SDLC stage runs in a FRESH process (`--no-extensions --no-session`). Stage-to-stage context does NOT leak. maker ≠ checker.

2. **Durable recovery**: state persists to `.pi/pipeline/state/<story-id>.json`. A crashed run resumes. State contradictions are repaired at load time.

3. **Fault containment**: a crash in the engine must not kill the supervisor.

4. **Harness-owned evidence**: the runner (not the agent) runs test/typecheck/lint and writes evidence to an agent-unwritable path. The merge gate compares agent claims against this evidence. Any divergence blocks the merge.

5. **Fail-closed PR terminal**: every failure to produce the deliverable resolves to `"needs-attention"`, never `"passed"`.

6. **Credential redaction**: all public surfaces (markers, progress, tool returns) are sanitized against credential patterns (bearer tokens, sk- keys, AIza keys, gh tokens, AWS keys).

7. **Per-story dispatch lock**: mkdir-atomic compare-and-set (EEXIST = contended). Stale-lock reclamation via `process.kill(pid, 0)` liveness probe or 6-hour age threshold.

## 7. Codebase Stats (modules moving from pi-orchestrator)

| Module                | Lines      | Owns                                                                    |
| --------------------- | ---------- | ----------------------------------------------------------------------- |
| runner.ts             | 9,104      | FSM loop, spawn, state, gates, budget, merge, locks, logging, redaction |
| story-pull-request.ts | 1,002      | Git worktree, PR opening, secret scanning (HS-14)                       |
| harness-evidence.ts   | 883        | Harness-owned test/typecheck/lint evidence + pre-merge gate (HS-1)      |
| model-config.ts       | 271        | Model resolution from 5 sources, pre-spawn validation                   |
| rundef/schema.ts      | 234        | TypeBox RunDef schema + cross-field invariants                          |
| state-reconcile.ts    | 221        | Crash recovery, contradiction repair                                    |
| rundef/compile.ts     | 172        | RunDef → StageDef compilation                                           |
| rundef/loader.ts      | 141        | Discovers .pi/bmad/pipelines/*.yaml                                     |
| rundef/selector.ts    | 133        | Builtin vs discovered resolution                                        |
| rundef/builtin.ts     | 123        | SDLC pipeline definition + resolution                                   |
| stage-budget.ts       | 112        | Per-stage spend ceiling evaluation                                      |
| rundef/ext-resolve.ts | 66         | Stage extension path resolution                                         |
| rundef/registry.ts    | 38         | Payload gate registry (module-level Map)                                |
| rundef/types.ts       | 36         | StageDef, PayloadGateResult, PayloadGate types                          |
| **Total**             | **12,585** |                                                                         |

## 8. Quality Gates

- **CRAP ≤ 5**: enforced by `scripts/crap-ratchet.mjs` (ratchet) and `scripts/crap-report.mjs` (report)
- **Coverage ≥ 90%**: statements, branches, functions, lines (vitest v8)
- **Strict ESLint**: type-checked + sonarjs + jsdoc + tsdoc + complexity ≤ 8 + cognitive complexity ≤ 10
- **TypeScript strict**: noUncheckedIndexedAccess, exactOptionalPropertyTypes, noPropertyAccessFromIndexSignature
- **TDD**: Red/Green/Refactor. Test files next to source: `src/foo.ts` → `src/foo.test.ts`
- **knip**: dead-code detection
- **Prettier**: format check

Full gate: `npm run check` runs typecheck → format → lint → coverage → CRAP → conformance → knip.

- **Checkpoint conformance**: `npm run conformance` (vitest.conformance.config.ts) validates every checkpoint policy/module under `.pi/workflows/` against pi-bmad's checkpoint-conformance contract, including over-claim defeat fixtures for rung-3 module gates.

## 9. Role Definitions

### ChatGPT (Architect)

- Reads code from the three GitHub repos
- Creates detailed task specifications (files, interfaces, tests)
- Reviews completed work against the migration plan
- Proposes the next implementation task
- Serves as the design authority for boundary decisions

### Implementer (Pi Pi + Subagents)

- Takes task specs from ChatGPT and dispatches subagents to write code
- Runs quality gates (`npm run check`) on every change
- Commits, pushes, and reports back with what was done
- Asks ChatGPT for the next task when current work is complete

## 10. The SDLC Pipeline Definition

```yaml
id: sdlc
stages:
  - id: create-story
    kind: agent
    workflow: create-story
    agent: sm
    timeout: 1800
  - id: e2e-plan
    kind: agent
    workflow: e2e-plan
    agent: tea
    timeout: 1800
  - id: dev-story
    kind: agent
    workflow: dev-story
    agent: dev
    timeout: 3600
  - id: e2e-verify
    kind: agent
    workflow: e2e-verify
    agent: tea
    gate: e2e-verify
    onFail: dev-story
    timeout: 7200
  - id: code-review
    kind: agent
    workflow: code-review
    agent: dev
    gate: code-review
    onFail: dev-story
    thinking: high
    timeout: 1800
  - id: docs
    kind: agent
    workflow: docs
    agent: architect
    thinking: high
    timeout: 1800
```

The built-in SDLC RunDef and payload gates belong in **pi-bmad-pipeline** (not pi-bmad), because they are cross-process dispatch decisions, not workflow definitions. The gate functions evaluate HeadlessWorkflowOutput payloads from separate processes — they are runner knowledge.

## 11. CLI Interface

```bash
bmad-pipeline run sdlc \
  --story-id STORY-123 \
  --spec-file ./specs/story-123.md \
  --project-root . \
  --jsonl

bmad-pipeline iso \
  --story-id STORY-123 \
  --spec-file ./specs/story-123.md \
  --project-root .

bmad-pipeline merge \
  --story-id STORY-123 \
  --project-root .

bmad-pipeline audit \
  --story-id STORY-123 \
  --project-root .
```

The CLI emits its own JSONL event protocol (`PipelineCliEvent`), not raw child stdout. Events include: `progress`, `stage.started`, `stage.finished`, `gate.decision`, `result`, `error`.
