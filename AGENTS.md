# AGENTS.md

Orientation index for agents working in this package.

## Current Context

- [Package context](CONTEXT.md) — mission, core flow, boundaries, and operational invariants
- [STY-112 plan](.pi/plans/code-stage-type.md) — approved implementation plan (6 slices, red/green TDD)

## Story Template

When writing a story file during the `create-story` workflow:

1. **Copy** `.pi/templates/story-plan.md` to `.pi/artifacts/implementation/stories/<story-id>.md`.
2. **Fill** each section following the workflow step guides — the template has HTML comments mapping sections to steps.
3. **KEEP the `- [ ]` checkbox prefix** on every item in `## Tasks / Subtasks` and `## Definition of Done`. The `story-ready` checkpoint **rejects plain `- ` bullets**.
4. **NEVER use `###` sub-headings inside `## Tasks / Subtasks` or `## Definition of Done`.** The checkpoint validator splits on ALL heading levels (h1–h6), so a `### Slice N` heading truncates the section → the validator sees zero checkboxes → REJECTED. Use **bold text** (`**Slice N — ...**`) for grouping instead.
5. Replace `{{PLACEHOLDER}}` text with story-specific content; remove placeholders you don't need but keep all 13 section headings.

## Per-Module Context

Each top-level module under `src/` has a `CONTEXT.md` with its responsibility, public seams, invariants, dependencies, and testing guidance. Read it before changing that module.

## Working Rules

- Run `npm run check` before completion; it covers typecheck, formatting, lint, coverage, CRAP, checkpoint conformance, and dead-code checks.
- Use red/green/refactor TDD. Keep colocated tests (`src/foo.ts` → `src/foo.test.ts`).
- Do not modify locked quality configuration: `eslint.config.js`, `.prettierrc*`, `vitest.config.ts`, `knip.json`, `tsconfig*.json`, or `scripts/crap-*.mjs`.
- Keep public functions documented and within the configured complexity limits.
- This package is the standalone `pi-bmad-pipeline` supervisor CLI, not a Pi extension.
