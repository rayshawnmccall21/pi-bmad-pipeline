# pi-package-template

A clean, reusable scaffold for building a **Pi extension package**. It carries the
strict [pi-bmad](https://github.com/) quality gates so every package built from it
is rigorous from day one: strict TypeScript, strict ESLint, a hard test-coverage
floor, CRAP complexity scoring + ratchet, architecture-boundary checks, and
documentation validation.

Any future pi-package — including **pi-co-founder** and future departments —
starts from this template.

## What you get

| File                                                            | Purpose                                                                                                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                                  | `pi.extensions` manifest + the full quality-gate script chain                                                                 |
| `tsconfig.json` / `tsconfig.test.json`                          | strict TS (12 extra strict flags); test config relaxes two for ergonomics                                                     |
| `eslint.config.js`                                              | strict type-checked + stylistic + sonarjs/unicorn/jsdoc/tsdoc + complexity/CRAP-supporting rules                              |
| `vitest.config.ts`                                              | v8 coverage with the 85/84/85/85 floor; `json` reporter feeds CRAP                                                            |
| `scripts/crap-report.mjs`                                       | CRAP scoring, fixed threshold 30, report-only                                                                                 |
| `scripts/crap-ratchet.mjs`                                      | CRAP ratchet — monotonic improvement vs a committed baseline                                                                  |
| `quality/crap-baseline.json`                                    | seeded CRAP baseline (regenerate via `crap:update-baseline`)                                                                  |
| `.dependency-cruiser.cjs`                                       | `no-circular` + `no-orphans` + module-boundary extension point                                                                |
| `typedoc.json`                                                  | doc validation (`lint:docs`), errors on undocumented public API                                                               |
| `lefthook.yml` / `.lintstagedrc.json` / `commitlint.config.cjs` | git hooks: lint-staged, commitlint, `check`-on-push                                                                           |
| `extension.ts`                                                  | real Pi extension entry: `registerTool` + `registerCommand` + `before_agent_start` + minimal-surface `setActiveTools` pattern |
| `.pi/extensions/template.ts`                                    | dev shim re-export (zero-flag `pi`, `/reload` hot-reload)                                                                     |
| `src/index.ts` + `src/index.test.ts`                            | trivial example module + test so the gates have something to run                                                              |

## Quick start

```bash
bun install          # or: npm install
bun run check        # run the full gate chain
```

## Quality-gate commands

| Command                        | What it does                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `npm run typecheck`            | `tsc --noEmit` — verify TS contracts                                                           |
| `npm run lint`                 | strict ESLint over `src/` + `extension.ts`, zero warnings tolerated                            |
| `npm run lint:fix`             | ESLint with `--fix`                                                                            |
| `npm run test`                 | run vitest once                                                                                |
| `npm run test:coverage`        | vitest with v8 coverage; fails below the 85/84/85/85 floor                                     |
| `npm run crap`                 | coverage + CRAP report (fails if any function CRAP > 30)                                       |
| `npm run crap:ratchet`         | enforce CRAP cannot regress vs `quality/crap-baseline.json`                                    |
| `npm run crap:update-baseline` | rewrite the baseline (do this in a baseline-only commit)                                       |
| `npm run lint:arch`            | dependency-cruiser: no circular deps, no orphans, module boundaries                            |
| `npm run lint:docs`            | TypeDoc validation: undocumented public API is an error                                        |
| **`npm run check`**            | **the aggregate gate: `typecheck && lint && test:coverage && crap && lint:arch && lint:docs`** |

### CRAP discipline

CRAP(m) = complexity(m)² × (1 − coverage(m)/100)³ + complexity(m). Complexity is
estimated from v8 branch data. Two layers:

- **`crap`** — report-only, fixed threshold 30. Fails the build if any function exceeds it.
- **`crap:ratchet`** — enforces monotonic improvement against `quality/crap-baseline.json`:
  fails on (a) any existing function rising above baseline + ε, (b) the count of
  functions above target increasing, (c) a new function landing at CRAP ≥ 10.
  Tighten `PACKAGE_TARGET` (30 → 20 → 10) in `scripts/crap-ratchet.mjs` at milestones.

## Building a package from the template

1. Copy this directory to your new package root and rename it in `package.json`.
2. Replace `src/index.ts` with your real module(s). Keep tests adjacent (`*.test.ts`).
3. Build out `extension.ts`:
   - register your real tools with `pi.registerTool({ name, label, description, parameters, execute })`,
   - register slash commands with `pi.registerCommand(...)`,
   - inject your persona via the `before_agent_start` hook,
   - **for a minimal tool surface**, list your allow-list in `ALLOWED_TOOLS` and let
     `restrictToolSurface` call `pi.setActiveTools([...])` to disable file-write/bash
     and expose only your own tools (this is how pi-co-founder restricts itself to
     Notion read/write + spawn).
4. Add per-module boundary rules in `.dependency-cruiser.cjs` (extension point marked
   inline) and a `scope-enum` in `commitlint.config.cjs` as your modules appear.
5. Point `typedoc.json` `entryPoints` at your public barrels.
6. Seed the CRAP baseline: `npm run crap:update-baseline`.
7. `npm run check` must stay green.

## Package boundary

This is a **pi-package** — an npm package with `pi.extensions` in `package.json`.

- **Package assets** resolve from `import.meta.url` (the installed package location).
- **Runtime state** resolves from `process.cwd()` (the consuming project root).
- **User preferences** resolve from `$HOME`.
- Never commit `.pi/state/`, `.pi/artifacts/`, or `.pi/logs/` — they are ephemeral.
- `.pi/extensions/template.ts` is the local dev shim; when the package is installed,
  Pi reads `package.json#pi.extensions` instead (no double-registration).

## ESM / runtime

Node + Bun compatible ESM (`"type": "module"`). Relative imports use the `.js`
specifier (e.g. `./src/index.js`) for NodeNext/bundler resolution, even though the
source is `.ts`.
