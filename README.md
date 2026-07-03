# pi-bmad-pipeline

Standalone **BMAD pipeline supervisor** CLI. It owns durable cross-process SDLC
pipeline execution: RunDef loading/compilation, stage spawning, JSONL parsing,
payload gates, routing/regression, worktrees, budgets/timeouts, harness-owned
evidence, PR/merge logic, and audit.

It is **not** a Pi extension. It imports `pi-bmad/contracts` and shells out to
`pi` as an opaque binary. The supervisor spawns fresh child processes and does
not trust them: it only trusts gated headless output, harness-owned evidence,
durable state, and its own gates. See `CONTEXT.md` for the full architecture
and trust-boundary rationale.

## Quick start

```bash
npm install
npm run check        # the full quality gate
```

## Quality gates

`npm run check` runs, in order:

| Step                    | What it does                                                                |
| ----------------------- | --------------------------------------------------------------------------- |
| `npm run typecheck`     | `tsc --noEmit` — strict TS (noUncheckedIndexedAccess, exactOptional, …)     |
| `npm run format:check`  | Prettier over the whole repo                                                |
| `npm run lint`          | strict type-checked ESLint over `src/`, `--max-warnings 0`                  |
| `npm run test:coverage` | vitest with v8 coverage; fails below the 90/90/90/90 floor                  |
| `npm run crap`          | coverage + CRAP report — fails if any function has CRAP > 5                 |
| `npm run conformance`   | checkpoint conformance suite over `.pi/workflows/` (separate vitest config) |
| `npm run knip`          | dead-code / unused-export detection                                         |

## The pi headless contract

Each pipeline stage runs in a **fresh, hermetic** `pi` child process. The
supervisor builds the invocation in `src/executors/pi/build-stage-args.ts`:

```bash
PI_BMAD_RUN_ID=<storyId.stageId.attempt> PI_BMAD_EMISSION_KEY=<secret> \
pi --mode json -p --no-session --no-extensions \
  -e <path-to-pi-bmad-extension> [-e <stage-extension>] \
  --bmad-workflow <workflow> --bmad-story <storyId> \
  --model <model> --thinking <effort> \
  "<stage prompt: spec file, stage id, attempt, prior findings>"
```

- `--mode json -p --no-session --no-extensions` — JSON event stream, print
  mode, no session persistence, no extension discovery; only the explicitly
  passed pi-bmad extension is loaded.
- `PI_BMAD_RUN_ID` / `PI_BMAD_EMISSION_KEY` — the emission env contract. The
  child stamps its terminal envelope with an `emissionProvenance` derived from
  the emission key.
- The terminal envelope travels inside `tool_execution_end` events at
  `result.details.headlessOutput` (emitted by pi-bmad's `bmad_emit_result`).
  The supervisor (`src/executors/pi/headless-stream-output.ts`) gates every
  candidate with `gateHeadlessTerminalOutput` from `pi-bmad/contracts` under
  the out-of-band emission key and **fails closed**: a forged stdout line is
  never trusted as a stage completion. Timeouts and the worktree cwd stay
  supervisor-owned.

## Checkpoints (`.pi/workflows/checkpoints/`)

Project checkpoint gates consumed by pi-bmad's checkpoint kernel live in
`.pi/workflows/checkpoints/`:

| File                                                 | What it registers                                                                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `merge-gate.mjs`                                     | Rung-3 module gate `pipeline--merge-gate-green` over the pipeline's durable on-disk merge contracts                                    |
| `validate-checkpoint-extensibility-checkpoints.yaml` | Lane A policies `pipeline--e2e-evidence-gate` (evidence) and `pipeline--e2e-command-gate` (command)                                    |
| `validate-checkpoint-extensibility-gates.mjs`        | Lane B rung-3 module gate `pipeline--e2e-module-gate`                                                                                  |
| `create-loop-checkpoints.yaml`                       | Lane A policies for the `create-loop` workflow: one `kind: evidence` gate and six `kind: command` gates (all rung 2; no rung-3 module) |

`merge-gate.mjs` runs on **plain Node** (no TypeScript imports) and
re-implements the preconditions of `src/git/merge-gate.ts` against the durable
artifacts the pipeline maintains:

- `.pi/pipeline/state/current-run.json` — current-run pointer
  `{ storyId, agentClaim? }` (written by `src/state/current-run-store.ts`)
- `.pi/pipeline/state/<storyId>.json` — durable `PipelineState`
- `.pi/pipeline/evidence/<storyId>/harness-evidence.json` — harness-owned
  evidence report

Set `PI_BMAD_PIPELINE_DEBUG=1` for the module gate's own stderr diagnostics.

The **conformance suite** (`tests/checkpoint-conformance.test.ts`, run via
`npm run conformance` and wired into `npm run check`) validates every
checkpoint policy and module in `.pi/workflows/` against pi-bmad's
checkpoint-conformance contract, including an over-claim defeat fixture for
each rung-3 module gate.

## The validate-checkpoint-extensibility workflow

`.pi/workflows/validate-checkpoint-extensibility.yaml` is a permanent
project workflow that proves the checkpoint extensibility stack end to end
through the real `pi` CLI: the Lane A evidence gate blocks fail-closed before
evidence exists and passes on policy-conformant evidence, the Lane A command
gate runs a real bounded command from the project root, the Lane B rung-3
`.mjs` module gate recomputes cross-field consistency on plain Node, and the
run terminates with a typed `bmad_emit_result` payload validated against
`.pi/schemas/validate-checkpoint-extensibility-result.schema.json`.

Run it headless from this repo root:

```bash
PI_BMAD_RUN_ID=<id> PI_BMAD_EMISSION_KEY=<secret> \
pi --mode json -p --no-session --no-extensions \
  -e /Users/Apple/pi-bmad/extensions/pi-bmad.ts \
  --bmad-workflow validate-checkpoint-extensibility \
  --bmad-story <storyId> "Validate the checkpoint extensibility stack"
```

Success means the final `tool_execution_end` envelope is accepted by
`gateHeadlessTerminalOutput` under the emission key you supplied. Probe
artifacts land in `.pi/artifacts/e2e/`.

## The create-loop workflow

`.pi/workflows/create-loop.yaml` guides an executing agent to build an agentic
loop **incrementally**, with deterministic checkpoints that test the loop as it
is being built. Methodology source: the global creating-loops skill
(`/Users/Apple/.pi/agent/skills/creating-loops`). The five steps write the
11-row loop contract, implement the bounded harness (`run-loop.sh`, a stub
agent, and `validate-receipts.mjs`), prove termination under budget with a
stub-agent smoke run, re-verify idempotently, and emit a typed result.

All checkpoints are Lane A rung 2 (policy file
`.pi/workflows/checkpoints/create-loop-checkpoints.yaml`) — one `kind: evidence`
gate over `contract-evidence.json` and six `kind: command` gates. No rung-3
module: integer-bound budget asserts stay in a `node -e` command gate rather
than climbing the rung ladder. The terminal step is `always-pass` with a guide
checklist; enforcement is the typed `bmad_emit_result` against
`.pi/schemas/create-loop-result.schema.json`.

Run it headless from this repo root:

```bash
PI_BMAD_RUN_ID=<id> PI_BMAD_EMISSION_KEY=<secret> \
pi --mode json -p --no-session --no-extensions \
  -e /Users/Apple/pi-bmad/extensions/pi-bmad.ts \
  --bmad-workflow create-loop \
  --bmad-story <storyId> "Build a bounded agentic loop"
```

The harness honors two env overrides — `MAX_ITERATIONS` (iteration cap) and
`LOOP_AGENT_CMD` (the agent invoked each iteration) — and uses two valid bounded
termination exit codes: `0` = exit condition met, `2` = budget exhausted.

## Debug logging

Set `BMAD_PIPELINE_DEBUG=1` to enable the supervisor's structured debug seam
(`src/events/debug-log.ts`). Events are single-line JSON records on stderr,
prefixed `bmad-pipeline:debug`, and cover decision seams only — never
per-iteration stream chatter:

| Event                 | Emitted by                       | Context carried                                                            |
| --------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| `stage.spawn`         | `executors/pi/run-bmad-stage.ts` | storyId, stageId, workflow, attempt, bin, argv, cwd, runId, timeout        |
| `stage.envelope-gate` | `executors/pi/run-bmad-stage.ts` | accepted/rejected verdict, exitCode, timedOut, aborted, fail-closed reason |
| `merge-gate.decision` | `git/merge-gate.ts`              | decision, blocker codes, summary reason                                    |
| `state.save`          | `state/fs-state-store.ts`        | storyId, state file path, status, currentStage, regressions                |
| `state.load`          | `state/fs-state-store.ts`        | storyId, state file path, found hit/miss, status                           |
| `lock.acquire`        | `state/dispatch-lock.ts`         | outcome (acquired/held/reclaimed), lock path, runId, holder info           |
| `lock.release`        | `state/dispatch-lock.ts`         | lock path                                                                  |

Every line passes through credential redaction (`src/security/redaction.ts`)
before it is written. The `stage.spawn` event logs argv but **never** the
emission env: emission keys are never logged.

```bash
BMAD_PIPELINE_DEBUG=1 <supervisor invocation> 2>&1 | grep '^bmad-pipeline:debug'
```

## Durable state layout

All supervisor state is project-local and survives crashes:

```
.pi/pipeline/
  state/<storyId>.json                    # durable PipelineState (atomic writes)
  state/current-run.json                  # current-run pointer for merge review
  locks/<storyId>/info.json               # per-story mkdir-atomic dispatch lock
  evidence/<storyId>/harness-evidence.json # harness-owned test/typecheck/lint evidence
```

## Development

- Red/Green TDD; tests live next to source (`src/foo.ts` → `src/foo.test.ts`).
- Quality-guard-locked files (do not modify): `eslint.config.js`,
  `.prettierrc`, `.prettierignore`, `scripts/crap-*.mjs`, `vitest.config.ts`,
  `knip.json`, `tsconfig.json`, `tsconfig.test.json`, `CLAUDE.md`.
- See `AGENTS.md` for agent rules and `CONTEXT.md` for the architecture,
  interfaces, and migration plan.
