# Build Loop Harness

Implement the bounded loop harness. The methodology is the creating-loops skill
**section 4 (wire backpressure before the first iteration)** — read
`/Users/Apple/.pi/agent/skills/creating-loops/SKILL.md` first. "A CI failure
after the agent is done is a gate. A failure the agent sees while working is
backpressure." The feedback signal must be an exit code, never the agent's
opinion — separate maker and checker.

## Methodology source

- **Read**: `/Users/Apple/.pi/agent/skills/creating-loops/SKILL.md` (section 4,
  backpressure-first; section 6, templates).
- Cross-reference `templates.md` for the minimal deterministic harness script
  shape — adapt, don't retype.

## Exit-code convention and env overrides

The harness honors two valid bounded-termination exit codes: **`0`** = exit
condition met, **`2`** = budget exhausted (iteration cap or wall-clock). Both
are success. Two env overrides select behavior:

- `MAX_ITERATIONS` — overrides the iteration cap (fall back to
  `budgets.maxLoops` from the contract when unset).
- `LOOP_AGENT_CMD` — path/command to the agent invoked each iteration.

## Artifact 1 — `.pi/loops/create-loop/run-loop.sh` (bash)

A bounded iteration loop that:

1. Loads `MAX_ITERATIONS` (default: the contract's `budgets.maxLoops`) and
   `LOOP_AGENT_CMD` from the environment.
2. Enforces a wall-clock budget derived from the contract's `budgets.wallClockMs`
   — abort with exit code `2` when exceeded.
3. Each iteration: invokes `$LOOP_AGENT_CMD`, appends **one JSON line** to
   `.pi/artifacts/create-loop/receipts.jsonl` with keys `iteration`,
   `timestamp`, `action`, `outcome`, `exitCode`.
4. Stops with exit `0` when the exit condition is met, exit `2` when the budget
   is exhausted (iteration cap reached or wall-clock exceeded). Both are valid
   bounded terminations.
5. Must never loop forever — the iteration cap is a hard backstop regardless of
   the agent's behavior.

Make the script `chmod +x`-able and start with `#!/usr/bin/env bash` and
`set -euo pipefail`.

## Artifact 2 — `.pi/loops/create-loop/stub-agent.sh` (bash)

A deterministic stub agent for testing. It must be completely deterministic
(same inputs → same outputs, same exit code) so the smoke run is reproducible.
A trivial fixed action that exits `0` is sufficient — the stub exists to prove
the harness terminates under budget and emits receipts, not to do real work.

## Artifact 3 — `.pi/loops/create-loop/validate-receipts.mjs` (plain Node)

A plain-Node validator (no runtime import of pi-bmad — it must run under `node`
alone). It:

1. Reads a receipts file path from `argv[2]` (default
   `.pi/artifacts/create-loop/receipts.jsonl`).
2. Reads `MAX_ITERATIONS` from the environment (default 2).
3. For every line: parses as JSON and asserts the required keys are present:
   `iteration`, `timestamp`, `action`, `outcome`, `exitCode`.
4. Asserts the highest `iteration` value does not exceed `MAX_ITERATIONS`.
5. Exits non-zero on any violation (parse error, missing key, over-cap).

The exact gate command is:
`env MAX_ITERATIONS=2 node .pi/loops/create-loop/validate-receipts.mjs .pi/artifacts/create-loop/receipts.jsonl`

## Gate at this step

- `create-loop--harness-syntax` — command gate:
  `bash -n .pi/loops/create-loop/run-loop.sh && bash -n .pi/loops/create-loop/stub-agent.sh && node --check .pi/loops/create-loop/validate-receipts.mjs`
  — syntax-checks all three files without executing the loop. It does NOT prove
  behavior; the next step (smoke-run) does.

Advance when all three files exist and the syntax gate passes.
