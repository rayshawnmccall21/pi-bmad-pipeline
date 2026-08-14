# security/ — Context

> Shared output-boundary redaction for credential-shaped text and JSON-like values.

## ADRs

- No planning ADR artifact is currently published. The `strip-1` boundary retains redaction as supervisor mechanism while deleting harness-evidence policy and storage.

## Invariants

- `redactText`, `redactError`, and `redactValue` replace supported credential shapes with `[REDACTED]` before diagnostics or events cross process boundaries.
- Match summaries are deterministic and returned with immutable results.
- Deep redaction traverses string leaves in JSON-like arrays/objects and freezes the sanitized structure.
- CLI failures, local-code diagnostics, events, and debug logs reuse this module as the shared redaction source.

## Gotchas

- Redaction is a last-line output control, not permission to retain or intentionally log secrets.
- Pattern changes can create both leaks and false positives; add focused fixtures for every credential family.
- This module no longer owns evidence commands, evidence storage, or audit assertions.

## Learnings

- 2026-08-06 — Separating redaction from evidence policy preserved the reusable security boundary while allowing the duplicate evidence store to be deleted.
