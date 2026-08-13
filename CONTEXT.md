# pi-bmad-pipeline context

## Mission

pi-bmad-pipeline executes finite-state machines defined in discovered `.pi/bmad/pipelines/*.yaml` files. It supervises one fresh, hermetic Pi child per stage, persists resumable state after transitions, and exposes redacted JSONL events plus process exit codes.

Mechanism stays in this package. Pipeline policy belongs in YAML and in the workflows named by YAML stages. External tools can consume durable state and events without adding policy to the supervisor.

## Core flow

```text
CLI run <rundef-id>
  -> acquire story dispatch lock
  -> load durable state
  -> discover, validate, and compile YAML RunDef
  -> resolve model configuration
  -> ensure isolated story worktree
  -> validate state identity or initialize state
  -> execute the FSM with one Pi child per stage
  -> persist every transition and emit events
  -> emit exactly one terminal result
  -> release the lock
```

Invalid catalogs, unregistered payload gates, mismatched resume identity, malformed child output, forged provenance, mismatched workflow/story identity, and contradictory positive gate verdicts fail closed.

## Module boundaries

- `src/rundef/`: YAML schema, loader, selector, compiler, registry, and RunDef identity.
- `src/core/`: FSM execution, routing, decisions, transitions, and budgets.
- `src/state/`: durable JSON state, validation, reconciliation, and locking.
- `src/executors/pi/`: hermetic Pi spawning, argv construction, JSONL parsing, provenance gating, timeout, and abort handling.
- `src/actions/`: composition root connecting selection, state, worktrees, models, the executor, and events.
- `src/git/`: worktree isolation and registration only.
- `src/gates/`: registered payload gates referenced by YAML.
- `src/events/`: redacted mechanism events and debug records.
- `src/security/`: output-boundary redaction.
- `src/cli*.ts`: `run`, `help`, and `version` parsing and dispatch.

Dependencies are injected at effect boundaries. Pure modules do not spawn children or mutate shared hidden state.

## RunDef and WorkflowDef

A RunDef is supervisor data: ordered stage IDs, workflow/agent names, routing, gates, timeouts, thinking, and budgets. A WorkflowDef belongs to pi-bmad and defines the work performed inside a child. The supervisor compiles RunDefs but does not embed product pipeline tables.

The repository includes `.pi/bmad/pipelines/sdlc.yaml` as discovered example data and as its self-supervision definition.

## Durable recovery and identity

State is stored at `.pi/pipeline/state/<story-id>.json`. It records the story, selected RunDef ID and digest, spec, canonical worktree/branch, model/thinking configuration, stage history, regressions, timestamps, and economics. Resume proceeds only when these identities match the active invocation. Interrupted running stages are reconciled before continuation and repaired state is persisted.

Worktree registration compares canonical filesystem identities so platform aliases such as `/tmp` and `/private/tmp` do not conflict with the run's own worktree.

## Child boundary

Each stage starts a fresh Pi process with discovery and sessions disabled, offline mode enabled, and exactly one explicit pi-bmad extension. A per-process emission key authenticates terminal output. Accepted output must also match the requested workflow. Payload gates receive the active story identity.

Timeout, abort escalation, nonzero exit, malformed JSONL, missing output, and provenance failures remain typed fail-closed outcomes. Credential-shaped output is redacted before event or debug serialization.

## Event and state interfaces

The event vocabulary is mechanism-only: run, stage, gate, budget, progress, result, and error. Records are immutable, redacted, and serialized one per line. A run emits exactly one result record.

The durable state JSON is the historical record. Operators can inspect it with standard tools such as `jq`; no second reporting store competes with it.

## CLI

```text
bmad-pipeline run <rundef-id> [--story-id ID] [--spec-file PATH] [options]
bmad-pipeline help
bmad-pipeline version
```

The built bin target is bundled for Node runtime execution while library source remains TypeScript ESM.

## Quality

`npm run check` enforces TypeScript, Prettier, ESLint, coverage, CRAP, checkpoint conformance, and dead-code checks. Core state, routing, worktree, redaction, parser, provenance, timeout, and abort tests remain part of the retained mechanism suite.
