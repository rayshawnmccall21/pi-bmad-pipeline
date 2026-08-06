# model/ — Context

> Pure deterministic resolution and validation of model name and thinking effort.

## ADRs

- No planning ADR artifact is currently published. Model configuration remains an injected mechanism independent of YAML discovery and process spawning.

## Invariants

- Model and thinking resolve independently in precedence order: explicit, stage, project, environment, caller defaults, built-in defaults.
- The selected model must be nonblank and thinking must be exactly `low`, `medium`, or `high`.
- Invalid selected values fail with structured `ModelConfigError` issues; resolution does not silently fall through to a lower-precedence source.
- Resolved configuration and issue collections are immutable.

## Gotchas

- A source may provide only one field; do not force model and thinking to come from the same source.
- Trim the selected model for output, but validate thinking against the literal vocabulary.
- Resume identity stores resolved model/thinking, so precedence changes can invalidate durable state.

## Learnings

- 2026-08-06 — Persisting resolved model configuration makes otherwise invisible invocation changes detectable during resume.
