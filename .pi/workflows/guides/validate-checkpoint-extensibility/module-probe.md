# Probe Module Gate

This step proves the Lane B rung-3 module gate (`pipeline--e2e-module-gate`, registered by `.pi/workflows/checkpoints/validate-checkpoint-extensibility-gates.mjs`) executes project code on plain Node and recomputes facts instead of trusting claims.

## Gate contract (from the module — that file is the single source of truth)

The gate reads `.pi/artifacts/e2e/module-state.json` through the project-root-contained `readJson` seam and fails closed unless ALL of the following recomputed facts match the claimed fields:

| Field             | Requirement                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkpoint`      | Literal `"pipeline--e2e-module-gate"`                                                                                                                                      |
| `status`          | Literal `"passed"`                                                                                                                                                         |
| `storyId`         | Filename-safe string (`^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`)                                                                                                      |
| `probes`          | Non-empty array; every item carries a non-empty string `name` and a string `status`                                                                                        |
| `totalProbes`     | Number strictly equal to `probes.length` — RECOMPUTED by the gate                                                                                                          |
| `passedProbes`    | Number strictly equal to the recomputed count of probes with `status: "passed"`                                                                                            |
| `allProbesPassed` | Boolean strictly equal to the recomputed conjunction, and it must be `true` — an over-claim against a failing probe fails closed, and an honestly non-green run also fails |

## 1. Write the module state JSON

Record one probe per lane exercised so far, with statuses reflecting what you actually observed (the gate recomputes the counts — do not hand-edit them into agreement with a wished-for verdict):

```json
{
  "checkpoint": "pipeline--e2e-module-gate",
  "status": "passed",
  "storyId": "E2E-CHECKPOINT-1",
  "probes": [
    { "name": "blocked-probe", "status": "passed" },
    { "name": "evidence-lane", "status": "passed" },
    { "name": "command-lane", "status": "passed" }
  ],
  "totalProbes": 3,
  "passedProbes": 3,
  "allProbesPassed": true
}
```

- `blocked-probe` — `"passed"` only if step 1's pre-evidence advance really was refused (`✗ Blocked`).
- `evidence-lane` — `"passed"` only if `pipeline--e2e-evidence-gate` then passed on the written evidence.
- `command-lane` — `"passed"` only if `pipeline--e2e-command-gate` passed on the marker file.

## 2. Advance through the gate

Call `bmad_workflow_step` with `action: advance`. On pass the workflow moves to `summarize`. Record the outcome for the `moduleGate` payload field.
