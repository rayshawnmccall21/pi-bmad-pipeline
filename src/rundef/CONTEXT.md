# rundef/ — Context

> Discovery, validation, identity, selection, compilation, and payload-gate registration for YAML-defined FSMs.

## ADRs

- No planning ADR artifact is currently published. The governing `strip-1` decision selects RunDefs only from `.pi/bmad/pipelines/*.yaml`; no built-in code pipeline exists.

## Invariants

- Discovery is deterministic, YAML-only, project-scoped, and fails closed on malformed files or duplicate IDs.
- Schema validation requires nonempty ordered stages, unique identifiers, paired `gate`/`onFail`, existing failure targets, and backward-only regression targets.
- Selection source is always `discovered`; an unknown valid ID raises typed `rundef-not-found`.
- Compilation resolves every named payload gate before execution, applies timeout defaults, and returns immutable stages/budgets.
- `computeRunDefDigest` supplies stable content identity used to reject unsafe resume against changed YAML.

## Gotchas

- `.pi/bmad/pipelines/sdlc.yaml` is example/discovered data, not a privileged fallback.
- Register gates before compilation; unresolved gate names are compile errors, not runtime no-ops.
- Keep loading/parsing separate from selection and compilation so callers can inject a preloaded catalog without creating hidden registry state.

## Learnings

- 2026-08-06 — Moving SDLC from TypeScript to YAML removed the builtin/discovered conflict branch and made the pipeline catalog the single source of truth.
