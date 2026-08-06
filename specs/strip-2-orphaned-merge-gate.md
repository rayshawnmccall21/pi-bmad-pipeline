# Story: Remove the orphaned merge-gate checkpoint

## Summary

The strip-1 story deleted harness evidence and the current-run pointer from
`src/`. The rung-3 checkpoint module `.pi/workflows/checkpoints/merge-gate.mjs`
consumed exactly those artifacts (`.pi/pipeline/state/current-run.json`,
`.pi/pipeline/evidence/<storyId>/harness-evidence.json`) — files nothing can
write anymore. It fails closed forever: dead policy mirroring deleted code.
Remove it and its wiring completely (unix mandate rule 6: deleting a
capability means deleting ALL of it).

## Unix philosophy mandate (governs every decision)

1. Each module does ONE thing well. 2. Compose via minimal interfaces.
3. No hidden shared mutable state. 4. Fail closed with typed errors.
5. Mechanism over policy. 6. Single source of truth — no orphans, no mirrors
of deleted code. 7. Text streams and exit codes at boundaries.

## DELETE

- `.pi/workflows/checkpoints/merge-gate.mjs`
- `src/checkpoints/merge-gate-module.test.ts`

## MODIFY

- `tests/checkpoint-conformance.test.ts`: remove the merge-gate module
  registration, its `pipeline--merge-gate-green` over-claim fixture, and any
  now-unused imports/helpers. The remaining validate-checkpoint-extensibility
  gate modules keep their full conformance coverage.
- Sweep any other reference to the merge-gate checkpoint (comments included)
  in `src/`, `tests/`, and `.pi/workflows/checkpoints/*.yaml` if present.

## OUT OF SCOPE — do not touch

- `.pi/loops/**` (has pending operator-owned uncommitted changes in the main
  checkout; not yours to resolve)
- `.pi/workflows/create-loop.yaml`, `.pi/workflows/checkpoints/create-loop-checkpoints.yaml`,
  `validate-checkpoint-extensibility*` (yaml, mjs, guides) — still live capabilities
- `.pi/extensions/quality-guard.ts`, `.pi/schemas/`, `.pi/artifacts/`
- Locked files: `eslint.config.js`, `.prettierrc*`, `vitest.config.ts`,
  `knip.json`, `tsconfig*.json`, `scripts/crap-*.mjs`
- Everything under `src/` except the single test file listed above

## Acceptance criteria

1. `npm run check` exits 0 (the conformance suite passes with the remaining
   checkpoint modules; coverage, CRAP, knip all green).
2. `grep -rn "merge-gate" src/ tests/ .pi/workflows/` returns nothing.
3. The two deleted files do not exist.
4. All work is committed as focused conventional commits; worktree status clean.
5. No retained test is weakened; only tests OF the deleted module are deleted.
