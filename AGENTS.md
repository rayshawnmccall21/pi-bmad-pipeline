# AGENTS.md

Orientation index for agents working in this package. No analysis, planning, or architecture artifacts are currently present under `.pi/artifacts/`; use the context links below and the implementation story for current scope.

## Current Context

- [Package context](CONTEXT.md) — mission, core flow, boundaries, and operational invariants
- [Story strip-1](.pi/artifacts/implementation/stories/strip-1.md) — accepted implementation scope and agent record
- [Story specification](specs/strip-to-yaml-fsm.md) — YAML-only FSM requirements and acceptance criteria

## Per-Module Context

Each top-level module under `src/` has a `CONTEXT.md` with its responsibility, public seams, invariants, dependencies, and testing guidance. Read it before changing that module.

## Working Rules

- Run `npm run check` before completion; it covers typecheck, formatting, lint, coverage, CRAP, checkpoint conformance, and dead-code checks.
- Use red/green/refactor TDD. Keep colocated tests (`src/foo.ts` → `src/foo.test.ts`).
- Do not modify locked quality configuration: `eslint.config.js`, `.prettierrc*`, `vitest.config.ts`, `knip.json`, `tsconfig*.json`, or `scripts/crap-*.mjs`.
- Keep public functions documented and within the configured complexity limits.
- This package is the standalone `pi-bmad-pipeline` supervisor CLI, not a Pi extension.
