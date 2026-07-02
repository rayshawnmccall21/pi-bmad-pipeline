# Summarize Validation Run

This step closes the run and exercises the typed result emit. It carries an `always-pass` checkpoint by design — the emit itself has no static-path deterministic check; the typed `bmad_emit_result` registration (compiled from `.pi/schemas/validate-checkpoint-extensibility-result.schema.json`) is the enforcement.

## Checklist (verify before advancing)

- [ ] `.pi/artifacts/e2e/blocked-probe.log` exists and contains the verbatim `✗ Blocked by **pipeline--e2e-evidence-gate**` refusal from the pre-evidence probe.
- [ ] `.pi/artifacts/e2e/evidence-probe.json` exists and is the evidence the gate accepted.
- [ ] `.pi/artifacts/e2e/command-probe.marker` exists.
- [ ] `.pi/artifacts/e2e/module-state.json` exists and its counts match its probe records.
- [ ] All three gates were observed passing through real `bmad_workflow_step` advances (never self-reported without an advance).

## Complete and emit

1. Call `bmad_workflow_step` with `action: advance` to complete this terminal step (`always-pass`).
2. As your FINAL action, call `bmad_emit_result` with the typed payload. Every field is required; no other keys are accepted (`additionalProperties: false`):

```json
{
  "storyId": "E2E-CHECKPOINT-1",
  "evidenceGate": "passed",
  "commandGate": "passed",
  "moduleGate": "passed",
  "blockedProbeObserved": true
}
```

- `evidenceGate` / `commandGate` / `moduleGate` — the final observed advance outcome per gate (`"passed"` or `"blocked"`). Report `"blocked"` honestly if a gate never passed.
- `blockedProbeObserved` — `true` only if the probe-blocked step's pre-evidence advance was refused with `✗ Blocked`.
