# Probe Evidence Gate Fail-Closed

This step proves the Lane A evidence gate (`pipeline--e2e-evidence-gate`) fails closed, then satisfies it. Order matters: the blocked probe MUST happen before any evidence is written.

## 1. Probe the gate BEFORE writing evidence

With `.pi/artifacts/e2e/evidence-probe.json` absent (delete any leftover from a previous run, along with the rest of `.pi/artifacts/e2e/`), call `bmad_workflow_step` with `action: advance`. The advance MUST be refused with a `✗ Blocked by **pipeline--e2e-evidence-gate**` response — the gate fails closed on missing evidence. If the advance succeeds here, the stack is broken: abort the workflow and report the defect.

Write the blocked response text (verbatim, including the failing checkpoint name and reason) to `.pi/artifacts/e2e/blocked-probe.log`. This log is the on-disk proof the blocked probe happened; the evidence you write next points at it via `probeLogPath`, and the gate verifies the path exists (pathFields).

## 2. Write the evidence JSON

Write `.pi/artifacts/e2e/evidence-probe.json` (static v1 checkpoint artifact path — overwrite whatever a previous run left there). The step does not complete until the evidence satisfies the policy.

Field table (rendered from the `pipeline--e2e-evidence-gate` entry in `.pi/workflows/checkpoints/validate-checkpoint-extensibility-checkpoints.yaml` — that file is the single source of truth; if they diverge, the policy wins):

| Field          | Requirement                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkpoint`   | Literal `"pipeline--e2e-evidence-gate"` (base field)                                                                                                                                                        |
| `status`       | `"passed"` or `"blocked"` (base field)                                                                                                                                                                      |
| `storyId`      | Non-empty string — the story id this run is bound to (requiredStrings)                                                                                                                                      |
| `probeLogPath` | Non-empty string: the `.pi/artifacts/e2e/blocked-probe.log` you just wrote. Must exist on disk (requiredStrings + pathFields)                                                                               |
| `verdict`      | `"green"` or `"blocked"` (enumFields). `"green"` is only valid when EVERY item in `probes` has `status: "passed"` (crossField — an over-claimed verdict fails the gate)                                     |
| `probes`       | Non-empty array (requiredArrays), one item per fail-closed probe performed. Every item carries `lane`, `artifactPath`, and `status` (objectArrayKeys). Every `artifactPath` must exist on disk (pathFields) |
| —              | No other keys are permitted (`additionalProperties: false`): any field outside `checkpoint`, `status`, `storyId`, `probeLogPath`, `verdict`, `probes` fails the gate                                        |

Example:

```json
{
  "checkpoint": "pipeline--e2e-evidence-gate",
  "status": "passed",
  "storyId": "E2E-CHECKPOINT-1",
  "probeLogPath": ".pi/artifacts/e2e/blocked-probe.log",
  "verdict": "green",
  "probes": [
    {
      "lane": "evidence",
      "artifactPath": ".pi/artifacts/e2e/blocked-probe.log",
      "status": "passed"
    }
  ]
}
```

The `probes` entry records the blocked probe you performed in part 1: lane `evidence`, `artifactPath` pointing at the blocked-probe log, and `status: "passed"` only if the advance really was refused.

## 3. Advance through the gate

Call `bmad_workflow_step` with `action: advance` again. It must now pass and move the workflow to `command-probe`. Remember both observations — the blocked refusal and the pass — for the `summarize` step's `blockedProbeObserved` and `evidenceGate` payload fields.
