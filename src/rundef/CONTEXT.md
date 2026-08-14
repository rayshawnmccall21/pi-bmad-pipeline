# rundef/ — Context

> Discovery, validation, identity, selection, compilation, and payload-gate registration for YAML-defined FSMs.

## ADRs

- No planning ADR artifact is currently published. The governing `strip-1` decision selects RunDefs only from `.pi/bmad/pipelines/*.yaml`; no built-in code pipeline exists.

## Invariants

- Discovery is deterministic, YAML-only, project-scoped, and fails closed on malformed files or duplicate IDs.
- Raw and compiled stages form a closed `agent | code` union; strict schemas reject unknown and cross-kind fields before compilation.
- Schema validation requires nonempty ordered stages, unique identifiers, paired agent `gate`/`onFail`, existing failure targets, and backward-only regression targets.
- Selection source is always `discovered`; an unknown valid ID raises typed `rundef-not-found`.
- Compilation resolves payload gates only for agent stages, applies timeout defaults, and returns immutable stages/budgets; code stages own a command and copied/frozen literal argv.
- `computeRunDefDigest` supplies stable content identity, including code command/args, used to reject unsafe resume against changed YAML.

## Gotchas

- `.pi/bmad/pipelines/sdlc.yaml` is example/discovered data, not a privileged fallback.
- Register gates before compilation; unresolved gate names are compile errors, not runtime no-ops.
- Keep loading/parsing separate from selection and compilation so callers can inject a preloaded catalog without creating hidden registry state.

## Learnings

- 2026-08-06 — Moving SDLC from TypeScript to YAML removed the builtin/discovered conflict branch and made the pipeline catalog the single source of truth.
- 2026-08-14 — A strict discriminated union prevents agent-only controls from leaking into code stages, while a frozen copied argv preserves deterministic compilation.
