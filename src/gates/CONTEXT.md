# gates/ — Context

> Canonical payload decisions registered by name for YAML stages that request BMAD verification gates.

## ADRs

- No planning ADR artifact is currently published. The `strip-1` mechanism retains named gates because YAML references them, while stage ordering and failure routes remain YAML policy.

## Invariants

- `e2e-verify` passes only canonical `verdict: pass`; `code-review` passes only canonical `verdict: approved`.
- Positive verdicts must include exactly the expected properties, valid counts/lists, matching story identity, and no contradictory failures/findings.
- Unknown verdicts, unknown properties, malformed fields, identity mismatch, and contradictory payloads fail closed.
- Failed gates return immutable reasons/findings suitable for backward regression.
- Registration is deterministic and idempotent through the RunDef gate registry.

## Gotchas

- Do not use fuzzy field sniffing or accept aliases not present in the pi-bmad result schemas.
- A schema-valid envelope is not sufficient for a pass; cross-field consistency and active story identity are gate responsibilities.
- Changing a gate name breaks YAML compilation for every RunDef that references it.

## Learnings

- 2026-08-06 — Exact property sets and cross-field checks are necessary to stop permissive payloads from turning malformed success claims into passes.
