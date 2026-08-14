# pi-bmad-pipeline context

## Mission

pi-bmad-pipeline executes finite-state machines defined in discovered `.pi/bmad/pipelines/*.yaml` files. It dispatches a closed `agent | code` stage union, persists resumable state after transitions, and exposes redacted JSONL events plus process exit codes.

Mechanism stays in this package. Pipeline policy belongs in YAML, in workflows named by agent stages, and in trusted commands named by code stages. External tools can consume durable state and events without adding policy to the supervisor.

## Core flow

```text
CLI run <rundef-id>
  -> acquire story dispatch lock
  -> load durable state
  -> discover, validate, and compile YAML RunDef
  -> resolve model configuration
  -> validate state identity or initialize state
  -> dispatch each stage at the exact projectRoot
  -> persist every transition and emit events
  -> emit exactly one terminal result
  -> release the lock
```

Invalid catalogs or mixed stage shapes, unregistered payload gates, mismatched resume identity, malformed agent output, forged provenance, mismatched workflow/story identity, and contradictory positive gate verdicts fail closed.

## Module boundaries

- `src/rundef/`: YAML schema, loader, selector, compiler, registry, and RunDef identity.
- `src/core/`: FSM execution, routing, decisions, transitions, and budgets.
- `src/state/`: durable JSON state, validation, reconciliation, and locking.
- `src/executors/`: shared executor contract and the exhaustive two-way stage dispatcher.
- `src/executors/pi/`: agent Pi spawning, argv construction, JSONL parsing, provenance gating, timeout, and abort handling.
- `src/executors/code/`: trusted direct command execution, safe diagnostics, and process-group cleanup.
- `src/actions/`: composition root connecting selection, state, models, both executor delegates, and events.
- `src/gates/`: registered agent payload gates referenced by YAML.
- `src/events/`: redacted mechanism events and debug records.
- `src/security/`: output-boundary redaction.
- `src/cli*.ts`: `run`, `help`, and `version` parsing and dispatch.

Dependencies are injected at effect boundaries. Pure modules do not spawn children or mutate shared hidden state.

## RunDef and WorkflowDef

A RunDef is supervisor data with an ordered, closed `agent | code` stage union. Agent stages name a workflow and agent and may configure payload-gate routing, thinking, budgets, extensions, and observability. Code stages contain only common metadata plus a nonblank executable `command` and literal string `args`; agent fields, shell strings, scripts, YAML `cwd`/`env`, gates, and retries are rejected. A WorkflowDef belongs to pi-bmad and defines the work performed inside an agent child. The supervisor compiles RunDefs but does not embed product pipeline tables.

The repository includes `.pi/bmad/pipelines/sdlc.yaml` as discovered example data and as its self-supervision definition.

## Durable recovery and identity

State is stored at `.pi/pipeline/state/<story-id>.json`. It records the story, selected RunDef ID and digest, spec, model/thinking configuration, stage history, regressions, timestamps, and economics. Resume proceeds only when these identities match the active invocation; the digest includes code command/args, so changing either blocks resume before spawn.

Recovery is at-least-once, not exactly-once. An interrupted running stage is reconciled to pending without fabricated history and runs again; authors must make commands idempotent when replay matters.

## Execution boundaries

`StageExecutorDispatcher` uses one exhaustive switch over the two supported kinds and owns exactly one agent delegate and one code delegate. There is no executor registry, plugin API, factory map, or added dependency, and each concrete executor rejects the wrong kind before starting a process.

Agent stages start Pi with discovery and sessions disabled and offline mode enabled. A per-process emission key authenticates terminal output; accepted output must also match the requested schema, workflow, and story. Payload gates receive the active story identity, and an agent exit `0` without authenticated validated output still fails.

Code stages directly spawn the exact executable and literal argv with `shell: false`, exact `projectRoot` cwd, ignored stdin, drained stdout/stderr, and full inherited `process.env`. Exit `0` succeeds with `output: null`; nonzero or missing exit codes fail terminally and never enter agent gate regression. Successful output is discarded. Failure diagnostics are capped at 16,384 characters and redacted before decisions, durable state, events, or debug logs. Timeout and abort signal the detached process group with `SIGTERM`, then bounded `SIGKILL`, to include descendants. Code execution is trusted local execution, not a sandbox.

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

`npm run check` enforces TypeScript, Prettier, ESLint, coverage, CRAP, checkpoint conformance, and dead-code checks. Core state, routing, redaction, parser, provenance, timeout, abort, and local process-boundary tests remain part of the retained mechanism suite.
