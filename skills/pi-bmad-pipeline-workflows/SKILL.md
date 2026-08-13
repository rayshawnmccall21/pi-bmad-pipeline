---
name: pi-bmad-pipeline-workflows
description: Create or revise pi-bmad-pipeline RunDef YAML for ordered pi-bmad workflows. Use for .pi/bmad/pipelines, stage composition, payload gates, regression routing, budgets, extensions, observability, or pipeline discovery failures.
license: MIT
compatibility: Requires Node.js 20+, pi-bmad-pipeline, and pi-bmad workflows available to child Pi processes.
metadata:
  package: pi-bmad-pipeline
---

# Author Pi-BMAD Pipelines

A RunDef is orchestration data: it orders small pi-bmad workflows and routes typed results. Keep workflow behavior in workflows; keep process supervision in the pipeline.

## Create

1. Inspect `bmad-pipeline help`, existing `.pi/bmad/pipelines/*.yaml`, and the workflows each stage will invoke. This step is complete when every workflow id exists and every gated workflow's return payload matches its gate.
2. Read the shipped [RunDef schema](../../src/rundef/schema.ts). Write one `.pi/bmad/pipelines/<id>.yaml`; the file is discoverable only at that path. Use stable lowercase hyphenated ids and one operation per stage.
3. Compose stages in execution order. Pair every `gate` with `onFail`, and route `onFail` to an earlier stage. Resolve gate names from the shipped [gate registry](../../src/gates/index.ts). This step is complete when all ids are unique and every regression target and gate resolves.
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

## Rules

- **Compose:** one stage invokes one workflow. Prefer another stage over a wrapper that mixes responsibilities.
- **Regressions:** `onFail` carries gate findings back to its target; `--max-regressions` is the run-wide bound. Omit `maxRetries`: the schema accepts it, but the runtime does not consume it.
- **Agents:** set required `agent` to the workflow owner; the workflow's effective agent controls the child run.
- **Gates:** use gates only for matching typed payloads. Executor errors, timeouts, malformed output, and missing output halt before payload gates.
- **Artifacts:** workflow files remain the artifact source of truth; pipeline state records attempts, findings, usage, exit, and duration rather than copying payloads or artifacts.
- **Source of truth:** prefer the schema, `bmad-pipeline help`, and current gate registry over copied field tables.
