# git/ — Context

> Git command and worktree isolation mechanisms for resumable story execution.

## ADRs

- No planning ADR artifact is currently published. Under `strip-1`, this module retains worktrees only; PR opening, secret scanning, and merge policy were removed.

## Invariants

- Story worktrees live under `.pi/pipeline/worktrees` with validated story-derived identities.
- Provisioning is idempotent: an exact path/branch registration is reusable, mismatches fail with typed `worktree-conflict`, and absent registrations may be created.
- Worktree paths are canonicalized before identity comparison so filesystem aliases do not create false conflicts.
- Git commands are bounded by timeout, capture diagnostics, and redact stdout/stderr before returning or throwing.

## Gotchas

- Keep supervised project root, canonical worktree path, branch, and requested story identity distinct.
- `git worktree list --porcelain` parsing is an interface contract; do not parse human-formatted output.
- This barrel must not regain merge, PR, audit, or secret-scan exports.

## Learnings

- 2026-08-06 — Durable resume needs canonical path comparison; lexical equality is insufficient on platforms where `/tmp` aliases another real path.
