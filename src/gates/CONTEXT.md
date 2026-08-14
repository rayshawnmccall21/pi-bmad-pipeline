# gates/ — Context

> Named canonical and compatibility payload decisions for agent stages that request BMAD verification gates.

## ADRs

- No planning ADR artifact is currently published. The `strip-1` mechanism retains named gates because YAML references them, while stage ordering and failure routes remain YAML policy.

## Invariants

- `e2e-verify` passes only canonical `verdict: pass`; `code-review` passes only canonical `verdict: approved`.
- Positive verdicts for the canonical `e2e-verify` and `code-review` gates must include exactly the expected properties, valid counts/lists, matching story identity, and no contradictory failures/findings.
- Canonical `code-review` approvals dual-read the exact four-key v1 envelope and the exact six-key v2 envelope; v2 requires `payloadVersion: pi-bmad.code-review.payload.v2` plus a string-list `findings` field.
- Unknown verdicts, envelope versions, properties, malformed fields, identity mismatch, and contradictory payloads fail closed in the canonical gates.
- `code-review-lenient` is an explicit compatibility gate: it also accepts `needs-dev` or `needs-verify` when normalized critical/high counts are both zero.
- Failed gates return immutable reasons/findings suitable for backward regression.
- Registration is deterministic and idempotent through the RunDef gate registry; the registration summary reports the two canonical gate names even though the lenient gate is also registered.

## Gotchas

- Do not use fuzzy field sniffing or accept aliases not present in the pi-bmad result schemas for canonical gates; add versioned exact-shape dual reads for contract migrations.
- A schema-valid envelope is not sufficient for a canonical pass; cross-field consistency, empty v2 approval findings, and active story identity are gate responsibilities.
- The lenient gate treats missing or invalid severity counts as zero; select it only when that compatibility policy is intentional.
- Changing a gate name breaks YAML compilation for every RunDef that references it.

## Learnings

- 2026-08-06 — Exact property sets and cross-field checks are necessary to stop permissive payloads from turning malformed success claims into passes.
- 2026-08-14 — Versioned payload migrations should use an explicit dual-read consumer: retain the exact v1 shape, admit only the canonical v2 shape, and fail closed on unknown versions.
