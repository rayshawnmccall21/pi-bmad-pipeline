# Agent Rules

## Quality Gates (non-negotiable)

All code must pass before any PR or completion:

```
npm run check
```

This runs: typecheck → prettier → eslint → vitest coverage → CRAP ≤ 5 → knip.

## Red/Green TDD

1. **Red** — Write a failing test first.
2. **Green** — Write the minimum code to pass.
3. **Refactor** — Clean up while keeping tests green.

Never write implementation without a test. Test files live next to source: `src/foo.ts` → `src/foo.test.ts`.

## Do Not Modify

These files are locked by the quality guard extension and must not be changed:

- `eslint.config.js` — Strict linter config
- `.prettierrc` / `.prettierignore` — Formatter config
- `scripts/crap-report.mjs` / `scripts/crap-ratchet.mjs` — CRAP scoring
- `vitest.config.ts` — Coverage thresholds
- `knip.json` — Dead code detection
- `tsconfig.json` / `tsconfig.test.json` — Compiler strictness
- `CLAUDE.md` — Agent instructions

## Conventions

- `src/` — All business logic.
- `src/cli.ts` — CLI entry point.
- Max complexity 8, max cognitive complexity 10, max 50 lines per function.
- All public functions need JSDoc with `@param`, `@returns`, `@example`.
- CRAP score ≤ 5 per function (complexity² × (1 - coverage)³ + complexity).

## Package Identity

This is `pi-bmad-pipeline` — the standalone BMAD pipeline supervisor CLI.
It is NOT a Pi extension. It imports `pi-bmad/contracts` and shells out to
`pi` as an opaque binary. It owns durable cross-process SDLC pipeline
execution.
