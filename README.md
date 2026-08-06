# pi-bmad-pipeline

A Unix-style supervisor for finite-state pipelines discovered from YAML. It runs one hermetic Pi child per stage, persists resumable state, and emits redacted JSONL events.

## Pipeline definitions

Place pipeline definitions in `.pi/bmad/pipelines/*.yaml`:

```yaml
id: example
stages:
  - id: implement
    kind: agent
    workflow: dev-story
    agent: dev
    timeout: 3600
  - id: verify
    kind: agent
    workflow: e2e-verify
    agent: tea
    gate: e2e-verify
    onFail: implement
    timeout: 7200
```

Definitions are validated and compiled before any child starts. Missing definitions, malformed YAML, duplicate IDs, and unregistered gates fail closed. The repository's `sdlc.yaml` is an example definition rather than compiled-in policy.

## CLI

```text
bmad-pipeline run <rundef-id> --story-id ID --spec-file PATH [--project-root DIR]
    [--model NAME] [--thinking EFFORT] [--max-regressions N] [--jsonl]
bmad-pipeline help
bmad-pipeline version
```

`run` acquires the story lock, selects discovered YAML, resolves the worktree and model, resumes or initializes durable state, runs the FSM, writes state after transitions, emits one terminal result, and releases the lock.

## Durable interfaces

- State: `.pi/pipeline/state/<story-id>.json`
- Locks and isolated worktrees: `.pi/pipeline/`
- Process API: one-line redacted JSONL events and exit codes

The durable state is the audit surface. Product policy belongs in YAML stages or in external tools that consume state and events.

## Development

```bash
npm install
npm run build
npm run check
```

`npm run check` runs type checking, formatting, linting, coverage, CRAP, checkpoint conformance, and knip.
