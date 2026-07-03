#!/usr/bin/env bash
#
# run-loop.sh — bounded agentic loop harness for the create-loop demo.
#
# Drives a flaky agent command ($LOOP_AGENT_CMD) once per iteration, retries on
# non-zero exit, and stops when the agent exits green (exit 0) or the budget is
# exhausted (exit 2). Both are valid bounded terminations.
#
# Env overrides:
#   MAX_ITERATIONS  iteration cap (default: contract budgets.maxLoops)
#   LOOP_AGENT_CMD  agent command invoked each iteration (default: stub-agent.sh)
#
# Exit codes: 0 = exit condition met (agent green); 2 = budget exhausted
# (iteration cap reached or wall-clock exceeded).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CONTRACT="$SCRIPT_DIR/loop-contract.json"
STUB_STATE="$SCRIPT_DIR/.stub-state"
RECEIPTS_DIR="$REPO_ROOT/.pi/artifacts/create-loop"
RECEIPTS="$RECEIPTS_DIR/receipts.jsonl"

# --- read contract budgets (positive-int source of truth) ---------------------
contract_value() {
  # $1 = dotted path under the contract JSON, e.g. budgets.maxLoops
  node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('$CONTRACT','utf8'));const parts='$1'.split('.');let v=c;for(const p of parts){v=v[p];}process.stdout.write(String(v));"
}

CONTRACT_MAX_LOOPS="$(contract_value budgets.maxLoops)"
CONTRACT_WALL_MS="$(contract_value budgets.wallClockMs)"

# --- honor env overrides ------------------------------------------------------
: "${MAX_ITERATIONS:=$CONTRACT_MAX_LOOPS}"
: "${LOOP_AGENT_CMD:=$SCRIPT_DIR/stub-agent.sh}"
WALL_CLOCK_MS="$CONTRACT_WALL_MS"

if ! [[ "$MAX_ITERATIONS" =~ ^[0-9]+$ ]] || [ "$MAX_ITERATIONS" -lt 1 ]; then
  echo "run-loop: MAX_ITERATIONS must be a positive integer (got '$MAX_ITERATIONS')" >&2
  exit 2
fi

# --- idempotent reset: stub state + receipts ---------------------------------
: > "$STUB_STATE"
mkdir -p "$RECEIPTS_DIR"
: > "$RECEIPTS"

# --- helpers ------------------------------------------------------------------
now_ms() {
  node -e "process.stdout.write(String(Date.now()))"
}

emit_receipt() {
  # $1 iteration (int), $2 action, $3 outcome, $4 exitCode
  node -e '
    const fs = require("fs");
    const line = JSON.stringify({
      iteration: parseInt(process.argv[1], 10),
      timestamp: new Date().toISOString(),
      action: process.argv[2],
      outcome: process.argv[3],
      exitCode: parseInt(process.argv[4], 10)
    });
    fs.appendFileSync(process.argv[5], line + "\n");
  ' "$1" "$2" "$3" "$4" "$RECEIPTS"
}

# --- main loop ----------------------------------------------------------------
START_MS="$(now_ms)"
iteration=0

while [ "$iteration" -lt "$MAX_ITERATIONS" ]; do
  # Wall-clock budget check before spending another iteration.
  elapsed=$(( $(now_ms) - START_MS ))
  if [ "$elapsed" -gt "$WALL_CLOCK_MS" ]; then
    echo "run-loop: wall-clock budget ${WALL_CLOCK_MS}ms exceeded after ${iteration} iteration(s); exiting 2" >&2
    exit 2
  fi

  iteration=$((iteration + 1))

  echo "run-loop: iteration ${iteration}/${MAX_ITERATIONS} invoking agent: ${LOOP_AGENT_CMD}" >&2

  set +e
  $LOOP_AGENT_CMD
  agentExitCode=$?
  set -e

  if [ "$agentExitCode" -eq 0 ]; then
    emit_receipt "$iteration" "invoke-agent" "green" "$agentExitCode"
    echo "run-loop: exit condition met on iteration ${iteration}; exiting 0" >&2
    exit 0
  fi

  # Non-zero exit: record the flaky attempt and retry within budget.
  emit_receipt "$iteration" "invoke-agent" "flaky" "$agentExitCode"
  echo "run-loop: iteration ${iteration} agent exited ${agentExitCode} (flaky); retrying" >&2
done

# Iteration cap reached without the agent going green — budget exhausted.
echo "run-loop: iteration cap ${MAX_ITERATIONS} reached without green; exiting 2" >&2
exit 2
