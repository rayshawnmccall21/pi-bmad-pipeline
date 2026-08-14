---
name: pi-bmad-pipeline-workflows
description: Create or revise pi-bmad-pipeline RunDef YAML for ordered agent workflows and trusted code commands. Use for .pi/bmad/pipelines, stage composition, payload gates, regression routing, budgets, extensions, observability, or pipeline discovery failures.
license: MIT
compatibility: Requires Node.js 20+ and pi-bmad-pipeline; agent stages also require pi-bmad workflows available to child Pi processes.
metadata:
  package: pi-bmad-pipeline
---

# Author Pi-BMAD Pipelines

A RunDef is orchestration data with a closed `agent | code` stage union. Agent stages order small pi-bmad workflows and route typed results; code stages run trusted deterministic commands. Keep workflow behavior in workflows and process supervision in the pipeline.

## Create

1. Inspect `bmad-pipeline help`, existing `.pi/bmad/pipelines/*.yaml`, every workflow named by an agent stage, and every executable named by a code stage. Confirm that each local command is trusted and intentionally allowed to run with the caller's environment. This step is complete when workflow ids exist, gated workflow payloads match their gates, and code execution is explicitly intended.
2. Read the shipped [RunDef schema](../../src/rundef/schema.ts). Write one `.pi/bmad/pipelines/<id>.yaml`; the file is discoverable only at that path. Use stable lowercase hyphenated ids, choose `kind: agent` or `kind: code` for every stage, and keep one operation per stage.
3. Compose stages in execution order. For agent stages, pair every `gate` with `onFail`, route `onFail` to an earlier stage, and resolve gate names from the shipped [gate registry](../../src/gates/index.ts). Code stages cannot use gates. This step is complete when all ids are unique and every agent regression target and gate resolves.
4. Run the skill-relative validator before dispatch:

```bash
node <skill-directory>/scripts/validate-rundef.mjs .pi/bmad/pipelines/<id>.yaml
```

The validator parses and compiles without starting a child. This step is complete when it prints the RunDef id and path with exit code 0.

5. Run only when execution is intended:

```bash
bmad-pipeline run <id> [--story-id <story>] [--spec-file <path>] \
  [--model <model>] [--max-regressions <n>] --jsonl
```

This step is complete when the terminal event and `.pi/pipeline/state/` agree. Report failed stages, gate findings, usage, and residual work.

## Mixed example

```yaml
id: delivery
stages:
  - id: implement
    kind: agent
    workflow: dev-story
    agent: dev
  - id: check
    kind: code
    command: npm
    args: ["run", "check"]
  - id: review
    kind: agent
    workflow: code-review
    agent: dev
    gate: code-review
    onFail: implement
```

## Rules

- **Compose:** one agent stage invokes one workflow; one code stage invokes one executable. Prefer another stage over a wrapper that mixes responsibilities.
- **Agents:** `workflow` and `agent` are required. Set `agent` to the workflow owner; the workflow's effective agent remains authoritative. Pi output must pass emission-key provenance plus schema, workflow, and story validation, even when Pi exits `0`.
- **Code:** `command` is a required nonblank executable and `args` is an optional string array. Do not add agent fields, gates, retries, shell/script strings, `cwd`, or `env`: mixed and unknown fields fail validation.
- **Execution:** code uses the executable and literal argv directly, with no shell, at the exact project root, with ignored stdin and full inherited `process.env`. Exit `0` succeeds with no BMAD payload; nonzero or missing exit codes fail terminally. Output is drained and discarded on success; retained failure diagnostics are bounded to 16,384 characters and redacted. Timeout or abort terminates the detached process group with `SIGTERM`, then bounded `SIGKILL`.
- **Trust and replay:** code execution has no sandbox. Recovery is at-least-once, not exactly-once: interrupted running stages return to pending and run again, so side-effecting commands must be idempotent.
- **Regressions:** agent `onFail` carries gate findings back to its target; `--max-regressions` is the run-wide bound.
- **Gates:** use gates only for matching agent payloads. Executor errors, timeouts, malformed output, missing agent output, and code failures halt before payload gates.
- **Artifacts:** workflow files remain the artifact source of truth; pipeline state records attempts, findings, usage, exit, and duration rather than copying payloads or artifacts.
- **Dispatch:** the runtime has exactly two delegates behind one exhaustive switch, not a registry or plugin API.
- **Source of truth:** prefer the schema, `bmad-pipeline help`, and current gate registry over copied field tables.
