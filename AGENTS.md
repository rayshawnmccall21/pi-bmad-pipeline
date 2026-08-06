# AGENTS.md

Orientation index for agents working in this package. No analysis, planning, or architecture artifacts are currently published under `.pi/artifacts/`; use the current implementation records below.

## Current Context

- [Package context](CONTEXT.md) — mission, core flow, boundaries, and operational invariants
- [Story strip-2](.pi/artifacts/implementation/stories/strip-2.md) — implementation scope and agent record
- [Story specification](specs/strip-2-orphaned-merge-gate.md) — requirements and acceptance criteria
- [E2E plan](.pi/artifacts/validation/strip-2/e2e-plan.json) — behavioral verification plan
- [E2E verification](.pi/artifacts/validation/strip-2/e2e-verify.json) — verification result

## Per-Module Context

Each top-level module under `src/` has a `CONTEXT.md` with its responsibility, public seams, invariants, dependencies, and testing guidance. Read it before changing that module.

## Working Rules

- Run `npm run check` before completion; it covers typecheck, formatting, lint, coverage, CRAP, checkpoint conformance, and dead-code checks.
- Use red/green/refactor TDD. Keep colocated tests (`src/foo.ts` → `src/foo.test.ts`).
- Do not modify locked quality configuration: `eslint.config.js`, `.prettierrc*`, `vitest.config.ts`, `knip.json`, `tsconfig*.json`, or `scripts/crap-*.mjs`.
- Keep public functions documented and within the configured complexity limits.
- This package is the standalone `pi-bmad-pipeline` supervisor CLI, not a Pi extension.
