# checkpoints/ — Context

> Conformance tests for project checkpoint modules; this directory is not part of the runtime pipeline supervisor.

## ADRs

- No planning ADR artifact is currently published. Project checkpoint modules remain a separate meta-layer under `.pi/workflows/checkpoints/`, as recorded by the `strip-1` out-of-scope boundary.

## Invariants

- Tests load real `.mjs` checkpoint modules and exercise them through a minimal injected, read-only API seam.
- Gate modules must fail closed for missing, malformed, stale, or cross-identity evidence.
- Runtime supervisor modules must not depend on this test-only directory.

## Gotchas

- These tests intentionally describe checkpoint assets that can outlive removed supervisor policy. Do not infer that the core CLI implements merge or evidence commands.
- Keep module URLs rooted at the repository checkpoint assets and avoid ambient filesystem reads in stub handlers.

## Learnings

- 2026-08-06 — YAML-FSM stripping left checkpoint conformance untouched; checkpoint policy and supervisor mechanism evolve independently.
