# AGENTS.md

Orientation index for agents working in this package. Read the linked artifacts for full context; this file only routes you to them.

## Research & Planning

No analysis, product, architecture, or epic artifacts are currently published under `.pi/artifacts/`.

## Current Context

- [Package context](CONTEXT.md) — mission, core flow, boundaries, and operational invariants
- [STY-115 specification](.pi/plans/stage-handoff.md) — bounded, redacted, replay-stable predecessor payload handoff

## Story Template

When writing a story file during the `create-story` workflow:

1. **Copy** `.pi/templates/story-plan.md` to `.pi/artifacts/implementation/stories/<story-id>.md`.
2. **Fill** each section following the workflow step guides — the template has HTML comments mapping sections to steps.
3. **KEEP the `- [ ]` checkbox prefix** on every item in `## Tasks / Subtasks` and `## Definition of Done`. The `story-ready` checkpoint **rejects plain `- ` bullets**.
4. **NEVER use `###` sub-headings inside `## Tasks / Subtasks` or `## Definition of Done`.** The checkpoint validator splits on ALL heading levels (h1–h6), so a `### Slice N` heading truncates the section → the validator sees zero checkboxes → REJECTED. Use **bold text** (`**Slice N — ...**`) for grouping instead.
5. Replace `{{PLACEHOLDER}}` text with story-specific content; remove placeholders you don't need but keep all 13 section headings.

## Source Intake Format

When writing `.pi/artifacts/implementation/story-source-intake.md`, use the checkpoint parser's exact list syntax:

```markdown
# Story Source Intake

- Issue Identifier: STY-123
- Title: Story title

## Upstream Source

Source details...
```

Do not replace these list fields with bold labels such as `**Story ID:**`; `story-ready` does not parse that format and will incorrectly report a possible source mis-route.

## Per-Module Context

Each top-level module under `src/` has a `CONTEXT.md` with its responsibility, public seams, invariants, dependencies, and testing guidance. Read it before changing that module.

## Working Rules

- Run `npm run check` before completion; it covers typecheck, formatting, lint, coverage, CRAP, checkpoint conformance, and dead-code checks.
- Use red/green/refactor TDD. Keep colocated tests (`src/foo.ts` → `src/foo.test.ts`).
- Do not modify locked quality configuration: `eslint.config.js`, `.prettierrc*`, `vitest.config.ts`, `knip.json`, `tsconfig*.json`, or `scripts/crap-*.mjs`.
- Keep public functions documented and within the configured complexity limits.
- This package is the standalone `pi-bmad-pipeline` supervisor CLI, not a Pi extension.

## Tool Discipline (headless agents)

- NEVER scan the filesystem from root (`find /`, `grep -r /`, `ls -R /`); it trips the 180s workflow watchdog and terminally fails the stage. Artifacts live under `.pi/artifacts/` relative to cwd.
- The `subagent` tool IS available in every pipeline stage. NEVER assume a tool is absent from memory — verify first with `subagent({action:"list"})`. dev-story and code-review are expected to delegate (scout probes, TDD worker tasks).
- If a workflow tool call has not been made recently, resume by calling `bmad_workflow_step(advance)` — do not end your turn with text only.
