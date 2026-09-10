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
    [--terminal-recovery-kind KIND] [--expected-receipt-run-id RUN_ID]
    [--recovery-reason REASON]
bmad-pipeline help
bmad-pipeline version
```

`run` acquires the story lock, selects discovered YAML, resolves model configuration, resumes or initializes durable state, dispatches stages at the exact project root, writes state after transitions, emits one terminal result, and releases the lock.

### Terminal semantic recovery

A completed (`done`) story whose candidate is accepted as contract-invalid can be reopened through one authenticated all-or-none option group. **The sanctioned operator route is the orchestrator's structured `run_pipeline` (holding the Git-common-directory landing slot for the entire supervisor child lifetime, with release in `finally`); this package's bare CLI recovery flags below are a low-level implementation/testing seam, never an operator-invoked recovery path.** No landing-slot implementation lives in this package; recovery here runs only under the per-story dispatch lock and relies on the orchestrator to hold the landing slot externally.

```text
--terminal-recovery-kind supersede-contract-invalid-candidate
--expected-receipt-run-id <current finalScopeReceipt.runId>
--recovery-reason <nonblank reason, at most 2048 UTF-8 bytes>
```

Partial groups, unknown kind literals, blank or >100-character expected run ids, and blank or oversized reasons fail during argument parsing before any effect. Recovery eligibility is the first permitted state write: a missing state rejects without initialization, no reconciliation is persisted before eligibility/compare-and-swap, and stale-ID, drift, committed `HEAD`, invalid kind, reconciliation-needed state, or any state other than an authority-free exact-tail `pending`, `running`, `failed`, or `needs-attention` retry never saves or spawns. Initial `done` recovery always requires the exact RunDef digest: its active checkpoint and final receipt must bind the same story, RunDef id/digest, spec, model, and thinking as the invocation, and `finalScopeReceipt.runId` must equal `--expected-receipt-run-id` (a compare-and-swap identity, not a secret). The reset target is never caller-selected: it is inferred as the exact compiled code-review stage named by the receipt's quality gate and that stage's earlier configured `onFail` target. Current branch, authenticated base OID, and the complete committed-plus-dirty scope must equal the receipt, and this first safe version additionally requires `HEAD` to equal the receipt `baseOid` (a pre-landing, uncommitted candidate); committed or drifted candidates reject. One atomic save then archives the exact old receipt in `supersededFinalScopeReceipts` (one-based append-only `sequence`, timestamp, new locked run id, normalized redacted reason, inferred reset target, and canonical RunDef identity), clears active approval, sets nonterminal fields, resets the inferred target and downstream to pending while preserving all history, attempts, regressions, economics, and earlier stages, and carries the reason into the reset target's findings. No child starts before that save succeeds. A matching tail retry resumes without a duplicate archive; only in an eligible in-progress state with no active checkpoint or receipt may its resume digest differ, and then only when canonical RunDefs are byte-equal after stripping stage `timeout` fields. The first transition save atomically adopts the new digest and canonical identity. Gate, workflow, `onFail`, extension, thinking, and every other change retain `state-identity-mismatch`; a retry against a fresh terminal receipt rejects as stale. After the correction the ordinary FSM reruns dev-story, code-review, and docs, and only a fresh normal final attestation creates a new active receipt.

The superseded history is immutable, append-only, ordered by `sequence`, and meaningful only as historical record: landing and verification keep reading the top-level `finalScopeReceipt` as the sole active authority. Operators must read the current run id from `finalScopeReceipt` and generate the reason themselves; never hand-edit the durable state file.

## Durable interfaces

- State: `.pi/pipeline/state/<story-id>.json`
- Locks: `.pi/pipeline/locks/`
- Process API: one-line redacted JSONL events and exit codes

The durable state is the audit surface. Receipt-aware state uses feature versions 2 and 3: version 2 persists an immutable review checkpoint and requires a Git-derived final scope receipt before `done`; version 3 adds the optional append-only `supersededFinalScopeReceipts` archive written by terminal semantic recovery and its canonical RunDef identity for timeout-only correction retries. Existing version-2 terminal states remain readable and correctable. Scope capture combines canonical base-to-`HEAD` committed paths with staged, unstaged, and untracked paths, so a clean worktree cannot hide post-review committed drift. Receipt paths reject traversal, control characters, malformed encoding, duplicates, and general symbolic links. The sole symbolic-link exception is the pi-bmad docs contract's exact root `CLAUDE.md -> AGENTS.md`; it requires a regular sibling `AGENTS.md` and is bound as a versioned link marker rather than followed. The receipt binds story/run/RunDef identity, exact branch and base OID, reviewed source/test/config bytes, fixed-policy docs bytes, the exact passing stage attempt, and the final working-tree digest. The docs policy permits root project documents and `docs/*.md` while excluding prompts, skills, specifications, workflow/configuration, hidden instruction trees, and executable agent context. Finalization always re-observes current Git scope—even when an interrupted preterminal receipt is already durable—while reusing the checkpoint run ID across action retries. Before normal resume selection, a valid legacy nonterminal state with passed review but no checkpoint is durably reset from review through downstream stages without consuming regression budget, then reruns those stages so review captures current bytes before docs; no checkpoint is synthesized from Git, handoff, or prior output. Separately, when a current-version all-passed run is missing its review checkpoint, guarded zero-stage recovery derives the exact durable passed-review identity from the recorded stage ID, attempt, and finish time, asks the trusted scope attestor to backfill the missing review checkpoint, durably saves it, and immediately performs a fresh final comparison without re-running pipeline stages. Incomplete or ambiguous identity, Git ambiguity, attestation failure, or persistence failure fails closed; durable state must not be hand-edited. Documentation-only allowance and non-documentation drift invalidation remain unchanged. Post-review reviewed-byte drift clears approval and reruns review; malformed or unattested scope fails closed. Product policy belongs in YAML stages or in external tools that consume state and events.

## Development

```bash
npm install
npm run build
npm run check
```

`npm run check` runs type checking, formatting, linting, coverage, CRAP, checkpoint conformance, full strict Knip, and production Knip pinned to the `dependencies`, `unlisted`, and `unresolved` issue set.
