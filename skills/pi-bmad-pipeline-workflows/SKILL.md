---
name: pi-bmad-pipeline-workflows
description: Author pi-bmad-pipeline RunDefs and thin pipeline runner scripts. Use when a repository needs .pi/bmad/pipelines YAML, stage or gate routing changes, pipeline validation, or a reusable bmad-pipeline command.
license: MIT
compatibility: Requires Node.js 20+, pi-bmad-pipeline, and pi-bmad workflows available to child Pi processes.
metadata:
  package: pi-bmad-pipeline
---

# Author Pi-BMAD Pipelines

A RunDef is orchestration data: it orders small pi-bmad workflows and routes typed results. Workflow behavior stays in workflows; process supervision stays in the pipeline.

## Author

1. Inspect `bmad-pipeline help`, every visible `.pi/bmad/pipelines/*.yaml`, and the workflows each stage invokes. Manually confirm workflow and agent ids on the installed pi-bmad surface and compare each gated result schema with its gate; the RunDef validator cannot prove either. Complete this step when every stage has an available producer and every gate has a compatible payload.
2. Read the shipped [RunDef schema](../../src/rundef/schema.ts). Write direct, visible `.yaml` files under `.pi/bmad/pipelines/`; document `id` controls selection. Nested files, dotfiles, and `.yml` are outside discovery. One invalid sibling or duplicate document id fails the catalog.
3. Compose stages in execution order. Pair each `gate` with `onFail`, route `onFail` to an earlier stage, and resolve gate names from the [gate registry](../../src/gates/index.ts). Complete this step when ids are unique and every regression target and gate resolves.
4. Validate the runtime-visible catalog before dispatch. Installed packages ship `dist`; in a source checkout run `npm run build` first.

```bash
node <skill-directory>/scripts/validate-rundef.mjs --project-root .
```

This proves YAML structure, cross-field routing, duplicate-id absence, and gate registration without starting a child. Complete this step when every discovered RunDef prints its id and path with exit code 0.

5. Run only when execution is intended:

```bash
bmad-pipeline run <id> [--project-root <dir>] [--story-id <story>] \
  [--spec-file <path>] [--model <model>] [--thinking <effort>] \
  [--max-regressions <n>] --jsonl
```

Complete this step when the terminal event and `.pi/pipeline/state/<story-id>.json` agree. Report failed stages, gate findings, usage, and residual work.

## Runner-script branch

A checked command is the default. Read [runner-scripts.md](references/runner-scripts.md) only when a stable repository entry point or JSONL adapter is an explicit deliverable.

## Rules

- **Compose:** one stage invokes one workflow. Add another stage when responsibilities differ.
- **Regressions:** `onFail` carries gate findings backward; `--max-regressions` is the run-wide bound. Omit `maxRetries`: the schema accepts it, but compilation discards it.
- **Agents:** set required `agent` to the workflow owner; the workflow's effective agent controls the child run.
- **Gates:** use a gate only for its typed payload. Executor errors, timeouts, malformed output, and missing output halt before payload gates.
- **Artifacts:** workflows own artifacts; pipeline state records attempts, findings, usage, exit, and duration.
- **Source of truth:** prefer the schema, `bmad-pipeline help`, and gate registry over copied field tables.
