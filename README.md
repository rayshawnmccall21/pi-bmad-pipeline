# pi-bmad-pipeline

A Unix-style supervisor for finite-state pipelines discovered from YAML. It dispatches closed `agent | code` stage kinds under one durable FSM, persists resumable state, and emits redacted JSONL events.

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
  - id: check
    kind: code
    command: npm
    args: ["run", "check"]
    timeout: 900
  - id: verify
    kind: agent
    workflow: e2e-verify
    agent: tea
    gate: e2e-verify
    onFail: implement
    timeout: 7200
```

Definitions are validated and compiled before any child starts. Missing definitions, malformed YAML, duplicate IDs, mixed-kind fields, and unregistered gates fail closed. The repository's `sdlc.yaml` is example data rather than compiled-in policy.

Agent stages run the named pi-bmad workflow and accept output only after emission-key provenance, schema, workflow, and story checks. Code stages directly spawn the executable and literal arguments with no shell, at the exact `--project-root`, with ignored stdin and the full inherited `process.env`; YAML cannot override `shell`, `cwd`, or `env`. Exit `0` succeeds without agent output. Other exits fail terminally. Output is continuously drained and discarded on success; failure diagnostics are capped at 16,384 characters and redacted before durable or public use. Timeout and abort terminate the detached process group with `SIGTERM`, then bounded `SIGKILL`.

Code stages are trusted local execution, not a sandbox. Recovery is at-least-once: an interrupted running stage returns to pending and may execute again, so commands that have side effects must be idempotent.

## CLI

```text
bmad-pipeline run <rundef-id> [--story-id ID] [--spec-file PATH] [--project-root DIR]
    [--model NAME] [--thinking EFFORT] [--max-regressions N] [--jsonl]
bmad-pipeline help
bmad-pipeline version
```

`run` acquires the story lock, selects discovered YAML, resolves model configuration, resumes or initializes durable state, dispatches stages at the exact project root, writes state after transitions, emits one terminal result, and releases the lock.

## Durable interfaces

- State: `.pi/pipeline/state/<story-id>.json`
- Locks: `.pi/pipeline/locks/`
- Process API: one-line redacted JSONL events and exit codes

The durable state is the audit surface. Receipt-aware state version 2 persists an immutable review checkpoint and requires a Git-derived final scope receipt before `done`. Scope capture combines canonical base-to-`HEAD` committed paths with staged, unstaged, and untracked paths, so a clean worktree cannot hide post-review committed drift. Receipt paths reject traversal, control characters, malformed encoding, and duplicates. The receipt binds story/run/RunDef identity, exact branch and base OID, reviewed source/test/config bytes, fixed-policy docs bytes, the exact passing stage attempt, and the final working-tree digest. The docs policy permits root project documents and `docs/*.md` while excluding prompts, skills, specifications, workflow/configuration, hidden instruction trees, and executable agent context. Finalization always re-observes current Git scope—even when an interrupted preterminal receipt is already durable—while reusing the checkpoint run ID across action retries. Before normal resume selection, a valid legacy nonterminal state with passed review but no checkpoint is durably reset from review through downstream stages without consuming regression budget, then reruns those stages so review captures current bytes before docs; no checkpoint is synthesized from Git, handoff, or prior output. Separately, when a current-version all-passed run is missing its review checkpoint, guarded zero-stage recovery derives the exact durable passed-review identity from the recorded stage ID, attempt, and finish time, asks the trusted scope attestor to backfill the missing review checkpoint, durably saves it, and immediately performs a fresh final comparison without re-running pipeline stages. Incomplete or ambiguous identity, Git ambiguity, attestation failure, or persistence failure fails closed; durable state must not be hand-edited. Documentation-only allowance and non-documentation drift invalidation remain unchanged. Post-review reviewed-byte drift clears approval and reruns review; malformed or unattested scope fails closed. Product policy belongs in YAML stages or in external tools that consume state and events.

## Development

```bash
npm install
npm run build
npm run check
```

`npm run check` runs type checking, formatting, linting, coverage, CRAP, checkpoint conformance, full strict Knip, and production Knip pinned to the `dependencies`, `unlisted`, and `unresolved` issue set.
