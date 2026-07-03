# Design Loop Contract

Write the loop's anatomy before any iteration runs. The methodology is the
creating-loops skill **section 3 (the 11-row loop contract)** — read
`/Users/Apple/.pi/agent/skills/creating-loops/SKILL.md` first. No contract row
may be TBD: "If one of these is missing, the loop usually becomes either a
manual prompt habit or an unsafe background automation." The contract is the
single source of truth that the harness and the smoke checks are built against.

## Methodology source

- **Read**: `/Users/Apple/.pi/agent/skills/creating-loops/SKILL.md` (section 3,
  the 11-row contract table: Objective, Trigger, Intake, Workspace, Context,
  Delegation, Verification, State, Budget, Escalation, Exit).
- Cross-reference `patterns.md` for the named loop pattern you are encoding.

## Artifact 1 — the loop contract

Write `.pi/loops/create-loop/loop-contract.json` with exactly these top-level
fields:

| Field           | Type   | Requirement                                                                                                     |
| --------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| `goal`          | string | What the loop optimizes for (the Objective row). Non-empty.                                                     |
| `exitCondition` | string | The deterministic exit condition (the Exit row). Non-empty.                                                     |
| `budgets`       | object | `maxLoops` integer > 0 and `wallClockMs` integer > 0 (the Budget row).                                          |
| `feedback`      | string | The deterministic feedback signal — a command whose exit code says pass/fail (the Verification row). Non-empty. |
| `receipts`      | string | The receipts plan/path (the State + observability rows). Non-empty.                                             |

Encode the remaining rows (Trigger, Intake, Workspace, Context, Delegation,
Escalation) into the field values as needed; the five fields above are what the
downstream `create-loop--contract-budgets` gate asserts, but every conceptual
row from the skill must be answered — no "TBD".

## Artifact 2 — self-audit evidence

The `create-loop--contract-evidence` gate is a `kind: evidence` Lane A check
whose policy is the single source of truth in
`.pi/workflows/checkpoints/create-loop-checkpoints.yaml`. Write
`.pi/artifacts/create-loop/contract-evidence.json` with:

| Field           | Requirement                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `checkpoint`    | Literal `"create-loop--contract-evidence"` (base field — required on every evidence doc)                            |
| `status`        | `"passed"` or `"blocked"` (base field — required on every evidence doc)                                             |
| `storyId`       | non-empty string                                                                                                    |
| `goal`          | non-empty string (echo the contract goal)                                                                           |
| `exitCondition` | non-empty string (echo the contract exit condition)                                                                 |
| `contractPath`  | non-empty string; must be a real path (checked as a path field) — use `.pi/loops/create-loop/loop-contract.json`    |
| `checks`        | array; every item is an object with `name` (string) and `status` (string) — one entry per contract row you verified |
| `verdict`       | one of `green`, `blocked`                                                                                           |

Cross-field rule: when `verdict` is `green`, **every** item in `checks` must
have `status` equal to `passed`. An over-claimed verdict fails closed.
`additionalProperties: false` — no keys outside `{checkpoint, status, storyId,
goal, exitCondition, contractPath, checks, verdict}`.

## Exit-code convention and env overrides (read once, applies to all steps)

The harness this workflow builds uses two valid bounded-termination exit codes:
**`0`** = exit condition met, **`2`** = budget exhausted (iteration cap or
wall-clock). Both are success for the smoke gates. Two env overrides select the
iteration cap and the agent the loop drives:

- `MAX_ITERATIONS` — overrides the iteration cap (integer > 0).
- `LOOP_AGENT_CMD` — path/command to the agent invoked each iteration (the stub
  agent during smoke, a real agent in production).

## Gates at this step

- `create-loop--contract-evidence` — evidence gate over
  `contract-evidence.json` (field table above).
- `create-loop--contract-budgets` — command gate: a `node -e` one-liner reads
  `loop-contract.json` and asserts `budgets.maxLoops` and `budgets.wallClockMs`
  are positive integers and `feedback` + `receipts` are non-empty strings.

Advance when both artifacts exist and both gates pass.
