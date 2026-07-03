# Summarize and Emit Result

Verify every artifact the workflow produced exists, then emit the typed result.
This step is rung 0: no deterministic static-path check exists for the emit
itself, so it is `always-pass` with this checklist; the typed
`bmad_emit_result` registration enforces the result schema.

## Honesty rule

Tick a box only when the artifact is confirmed present and non-empty. Do not
advance with a missing or empty artifact — the typed emit will be rejected
against the schema if the payload is inconsistent.

## Artifact checklist

- [ ] `.pi/loops/create-loop/loop-contract.json` — the 11-row loop contract.
- [ ] `.pi/artifacts/create-loop/contract-evidence.json` — self-audit evidence.
- [ ] `.pi/loops/create-loop/run-loop.sh` — bounded harness.
- [ ] `.pi/loops/create-loop/stub-agent.sh` — deterministic stub agent.
- [ ] `.pi/loops/create-loop/validate-receipts.mjs` — receipts validator.
- [ ] `.pi/artifacts/create-loop/receipts.jsonl` — non-empty receipts from the verified smoke run.

## Emit the typed result

Emit the result payload via `bmad_emit_result` (exactly once, as the final
action of this workflow) with these fields, validated against
`.pi/schemas/create-loop-result.schema.json`:

| Field             | Type                   | Value                                                                                               |
| ----------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `storyId`         | string (minLength 1)   | the story id this run was bound to                                                                  |
| `contractPath`    | string (minLength 1)   | `.pi/loops/create-loop/loop-contract.json`                                                          |
| `smokeExitCode`   | integer, enum `[0, 2]` | final observed bounded-smoke exit code (0 = exit condition met, 2 = budget exhausted)               |
| `receiptCount`    | integer (minimum 1)    | number of receipt lines in the verified run                                                         |
| `budgetsEnforced` | boolean                | true when the harness honored the iteration cap and wall-clock budget during the verified smoke run |

All five fields are required; `additionalProperties: false`.
