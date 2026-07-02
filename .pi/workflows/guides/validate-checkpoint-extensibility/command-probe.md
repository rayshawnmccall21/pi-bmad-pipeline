# Probe Command Gate

This step proves the Lane A command gate (`pipeline--e2e-command-gate`) executes a real command against the project root and gates advancement on its exit code.

## Gate contract (from `.pi/workflows/checkpoints/validate-checkpoint-extensibility-checkpoints.yaml`)

- `kind: command` — the gate shells out; it does not read agent-written evidence.
- `command: test -f .pi/artifacts/e2e/command-probe.marker`, run from the project root.
- `passOn: exit-zero` — the gate passes only when the command exits `0`.
- Bounded execution: `timeoutMs: 10000`, `maxRetries: 1`. A timeout or crash fails closed.

## 1. Create the marker file

Write `.pi/artifacts/e2e/command-probe.marker`. Content is not inspected by the gate, but record something auditable — the story id and an ISO timestamp, one per line:

```
storyId: E2E-CHECKPOINT-1
createdAt: 2026-07-02T00:00:00.000Z
```

## 2. Advance through the gate

Call `bmad_workflow_step` with `action: advance`. The gate runs the `test -f` command itself — it does not trust your claim that the file exists. On pass the workflow moves to `module-probe`. Record the outcome for the `summarize` step's `commandGate` payload field.

If the advance is blocked, the marker path is wrong or was not written — fix the file (exact path: `.pi/artifacts/e2e/command-probe.marker`) and advance again.
