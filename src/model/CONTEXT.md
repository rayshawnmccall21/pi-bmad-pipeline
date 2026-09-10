# model/ — Context

> Pure deterministic resolution and validation of model name and thinking effort.

## ADRs

- No planning ADR artifact is currently published. Model configuration remains an injected mechanism independent of YAML discovery and process spawning.

## Invariants

- Model and thinking resolve independently in precedence order: explicit, stage, project, environment, caller defaults, built-in defaults.
- The selected model must be provider-qualified as `provider/model` (model IDs may contain additional nonempty slash-delimited segments), and thinking must be exactly `low`, `medium`, or `high`. The built-in default is the full Pi selector `openrouter/openai/gpt-5.5-pro`.
- Invalid selected values fail with structured `ModelConfigError` issues; resolution does not silently fall through to a lower-precedence source.
- Resolved configuration and issue collections are immutable.

## Gotchas

- A source may provide only one field; do not force model and thinking to come from the same source.
- Trim the selected model for output, reject whitespace or empty path segments within it, and validate thinking against the literal vocabulary.
- Resume identity stores resolved model/thinking. Exactly the historical bare default `gpt-5.5-pro` normalizes to the built-in full selector at config and resume identity boundaries; no other bare model is accepted.

## Learnings

- 2026-08-06 — Persisting resolved model configuration makes otherwise invisible invocation changes detectable during resume.
