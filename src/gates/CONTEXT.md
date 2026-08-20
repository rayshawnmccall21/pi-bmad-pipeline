# gates/ — Context

> Named canonical and compatibility payload decisions for agent stages that request BMAD verification gates.

## ADRs

- No planning ADR artifact is currently published. The `strip-1` mechanism retains named gates because YAML references them, while stage ordering and failure routes remain YAML policy.

## Invariants

- `e2e-verify` passes only canonical `verdict: pass`; strict `code-review` passes only canonical `verdict: approved`.
- Positive verdicts for the canonical `e2e-verify` and `code-review` gates must include exactly the expected properties, valid evidence, matching story identity, and no contradictory failures/findings.
- Canonical code-review approval validation dual-reads the exact four-key v1 envelope (`storyId`, `verdict`, `findingsBySeverity`, `autoFixed`) and exact six-key v2 envelope, which adds `findings` and `payloadVersion: pi-bmad.code-review.payload.v2`. Strict negative verdict branches fail without canonical envelope validation; `code-review-critical-only` validates either exact envelope for every recognized verdict.
- A v2 `findings` array contains at most 50 exact objects with only `id`, `severity`, `title`, `locations`, and `requiredAction`. `id`, `title`, and `requiredAction` are strings; `severity` is exactly `critical`, `high`, `medium`, `low`, or `info`; `title` is at most 1024 characters and `requiredAction` is at most 2048 characters.
- Each structured finding contains at most 20 exact `{ path, line }` locations: `path` is a string of at most 512 characters, and `line` is an integer at least 1.
- V2 severity summaries contain exactly the five canonical severity counts. Every count is a finite nonnegative integer equal to the number of structured findings at that severity; legacy string findings and mixed string/object arrays are rejected.
- Strict `code-review` remains approval-only: passing requires an exact `approved` payload with every severity count zero and, for v2, an empty structured `findings` array.
- For canonical gates, positive `pass`/`approved` verdicts validate exact envelopes and fail closed on malformed or contradictory evidence; identity mismatches and unknown verdicts always fail closed. Current negative `fail`/`needs-*` branches produce failures without fully validating envelope shape, version, or nested evidence.
- `code-review-lenient` is an explicit compatibility gate: it also accepts `needs-dev` or `needs-verify` when normalized critical/high counts are both zero.
- `code-review-critical-only` accepts any canonical code-review verdict only after the complete exact envelope, applicable structured details and bounds, severity count/detail consistency, and story identity validate; it passes only when Critical is zero, so validated lower severities do not block. Positive Critical fails with an immutable worst-first severity summary and, for v2, deterministic formatted details.
- Failed gates return immutable reasons/findings suitable for backward regression. Gate evaluation does not mutate the authenticated payload, structured findings, or nested locations; the result's string findings channel is not the source of record.
- Registration is deterministic and idempotent through the RunDef gate registry; the registration summary reports only the two canonical gate names even though additional review policy gates are also registered.

## Gotchas

- Do not use fuzzy field sniffing or accept aliases not present in the pi-bmad result schemas for canonical gates; add versioned exact-shape dual reads for contract migrations.
- A schema-valid envelope is not sufficient for a canonical pass; cross-field consistency, zero-count/empty-structured v2 approval findings, and active story identity are gate responsibilities.
- Legacy v2 string lists are not a compatibility envelope; only exact bounded structured finding and location objects are canonical v2 evidence.
- The lenient gate treats missing or invalid severity counts as zero; select it only when that compatibility policy is intentional.
- The critical-only gate tolerates lower severities only after complete envelope, nested detail, bound, and count validation; malformed or missing evidence never counts as zero.
- On a positive Critical result, v2 failure details format every validated structured finding in original payload order, including lower severities; the returned string list is neither Critical-filtered nor a separately sorted source of record.
- Changing a gate name breaks YAML compilation for every RunDef that references it; gate selection, stage ordering, and failure routing remain YAML policy.

## Learnings

- 2026-08-06 — Exact property sets and cross-field checks are necessary to stop permissive payloads from turning malformed success claims into passes.
- 2026-08-14 — Versioned payload migrations should use an explicit dual-read consumer: retain the exact v1 shape, admit only the canonical v2 shape, and fail closed on unknown versions.
- 2026-08-19 — Severity tolerance does not imply payload tolerance: a threshold gate may ignore lower-severity counts only after the complete envelope and every severity count validate exactly.
- 2026-08-20 — Structured v2 policy is applied only after exact bounded nested validation and severity count/detail reconciliation; legacy strings are rejected rather than normalized.
