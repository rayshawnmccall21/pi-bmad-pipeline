# checkpoints/ — Context

> Conformance tests for live project checkpoint modules; this directory is not part of the runtime pipeline supervisor.

## ADRs

- No planning ADR artifact is currently published. Project checkpoint modules remain a separate meta-layer under `.pi/workflows/checkpoints/`.

## Invariants

- Tests load real `.mjs` checkpoint modules and exercise them through a minimal injected, read-only API seam.
- Live gate modules must fail closed for missing, malformed, inconsistent, or cross-identity evidence.
- Deleted checkpoint capabilities must not remain discoverable or retain dedicated test wiring.
- Runtime supervisor modules must not depend on this test-only directory.

## Gotchas

- Keep module URLs rooted at the repository checkpoint assets and avoid ambient filesystem reads in stub handlers.
- A checkpoint module under `.pi/workflows/checkpoints/` is presence-discovered; deleting a capability requires deleting its module and all conformance fixtures and references.
- The downstream absence regression assembles the removed module basename from neutral fragments so the scoped zero-reference grep remains authoritative.

## Learnings

- 2026-08-06 — Removing the orphaned policy checkpoint left only the live extensibility gate suite; retained mismatch and over-claim cases still fail closed.
