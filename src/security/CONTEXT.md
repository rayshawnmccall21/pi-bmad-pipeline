# security/ — Context

> Shared credential redaction, canonical bounded StageHandoff normalization, and immutable review/final repository-scope receipts.

## ADRs

- No planning ADR artifact is currently published. The `strip-1` boundary retains redaction as supervisor mechanism while deleting harness-evidence policy and storage.

## Invariants

- `redactText`, `redactError`, and `redactValue` replace supported credential shapes with `[REDACTED]` before diagnostics or events cross process boundaries.
- Match summaries are deterministic and returned with immutable results.
- Deep redaction traverses string leaves in JSON-like arrays/objects, preserves every enumerable own key (including `__proto__`), and freezes the sanitized structure.
- `createStageHandoff` accepts only finite JSON primitives and acyclic plain arrays/objects, redacts before compact serialization, and rejects values above the 32 KiB UTF-8 ceiling without truncation.
- `sanitizeStageHandoff` re-parses persisted or prompt-bound strings through the same normalization boundary; accepted handoffs are canonical branded strings.
- CLI failures, local-code diagnostics, events, debug logs, durable state, and successor prompts reuse this module as the shared redaction source.
- Final scope receipts canonicalize repository-relative paths, hash exact bytes deterministically, bind review identity and quality-attempt coordinates, enforce the caller-supplied exact documentation allowlist after review, and freeze every returned structure; state loading separately correlates the receipt with the exact durable passed attempt.
- Scope construction accepts a transient present/absent snapshot union. A fixed nonnumeric tombstone marker frames an absent record so the tombstone cannot alias an empty file or real file bytes. Legacy all-present digest framing is unchanged and compatible; the durable v1 `{ paths, digest }` key set and schema are unchanged, with no new persisted absence field.

## Gotchas

- Redaction is a last-line output control, not permission to retain or intentionally log secrets.
- Pattern changes can create both leaks and false positives; add focused fixtures for every credential family.
- Bounds are measured after redaction and UTF-8 serialization. Never truncate JSON, and never move the cap check to character length.
- Normalization fails closed on accessors that throw, cycles, non-finite numbers, non-plain prototypes, and malformed JSON; it canonicalizes valid serialized input. State loading separately rejects persisted strings whose original bytes differ from that canonical result.
- This module no longer owns evidence commands, evidence storage, or audit assertions.
- Scope constructors validate canonical repository-relative present or absent snapshots and exact caller-supplied documentation allowlists. Tombstone framing constants are compatibility-sensitive. The action boundary supplies complete committed and dirty Git scope and excludes prompts, skills, specs, configuration/workflows, and executable instruction Markdown from its docs-only allowlist; model handoffs never authorize repository paths.
- StageHandoff APIs are direct exports of `security/stage-handoff.js`, not exports of the top-level `security/index.js` barrel. The 32 KiB cap is an internal policy constant; consumers and tests must verify accepted/rejected UTF-8 boundary behavior rather than import the constant.

## Learnings

- 2026-08-06 — Separating redaction from evidence policy preserved the reusable security boundary while allowing the duplicate evidence store to be deleted.
- 2026-08-15 — A single branded normalization seam makes redaction, compact serialization, UTF-8 bounds, durable validation, and prompt validation enforce the same fail-closed contract.
- 2026-08-20 — Final-scope authorization must compare canonical exact-byte scopes and durable quality-attempt identity rather than trusting filenames reported by an agent.
- 2026-08-25 — Security limits remain enforceable without becoming public API when tests pin exact boundary behavior through the normal normalization seam.
