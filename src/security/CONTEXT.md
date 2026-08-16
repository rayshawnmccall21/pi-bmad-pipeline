# security/ — Context

> Shared credential redaction plus canonical, bounded StageHandoff normalization for authenticated JSON-like payloads.

## ADRs

- No planning ADR artifact is currently published. The `strip-1` boundary retains redaction as supervisor mechanism while deleting harness-evidence policy and storage.

## Invariants

- `redactText`, `redactError`, and `redactValue` replace supported credential shapes with `[REDACTED]` before diagnostics or events cross process boundaries.
- Match summaries are deterministic and returned with immutable results.
- Deep redaction traverses string leaves in JSON-like arrays/objects, preserves every enumerable own key (including `__proto__`), and freezes the sanitized structure.
- `createStageHandoff` accepts only finite JSON primitives and acyclic plain arrays/objects, redacts before compact serialization, and rejects values above the 32 KiB UTF-8 ceiling without truncation.
- `sanitizeStageHandoff` re-parses persisted or prompt-bound strings through the same normalization boundary; accepted handoffs are canonical branded strings.
- CLI failures, local-code diagnostics, events, debug logs, durable state, and successor prompts reuse this module as the shared redaction source.

## Gotchas

- Redaction is a last-line output control, not permission to retain or intentionally log secrets.
- Pattern changes can create both leaks and false positives; add focused fixtures for every credential family.
- Bounds are measured after redaction and UTF-8 serialization. Never truncate JSON, and never move the cap check to character length.
- Normalization fails closed on accessors that throw, cycles, non-finite numbers, non-plain prototypes, malformed JSON, and non-canonical persisted strings.
- This module no longer owns evidence commands, evidence storage, or audit assertions.

## Learnings

- 2026-08-06 — Separating redaction from evidence policy preserved the reusable security boundary while allowing the duplicate evidence store to be deleted.
- 2026-08-15 — A single branded normalization seam makes redaction, compact serialization, UTF-8 bounds, durable validation, and prompt validation enforce the same fail-closed contract.
