# Final Verify

Run the guardrail pass and an idempotent re-verification of the smoke run. The
methodology is the creating-loops skill **section 5 (guardrail the failure
modes)** — read `/Users/Apple/.pi/agent/skills/creating-loops/SKILL.md` first.
The non-negotiable minimum is eight guardrails, each pointing at a concrete
mechanism: hard iteration cap, per-blocker retry budget, repeat-evidence stop,
maker/checker split, a no-test-weakening rule, receipts at exit, an escalation
destination, and an explicit permission boundary.

## Methodology source

- **Read**: `/Users/Apple/.pi/agent/skills/creating-loops/SKILL.md` (section 5,
  the eight guardrail minimums).

## Guardrail pass — checklist

Verify each guardrail is concretely wired. This is a self-audit checklist; the
**honesty rule** applies: tick a box only when you can point at the concrete
mechanism (a line in the harness, a field in the contract). If you cannot, the
guardrail is unmet — fix it before advancing, do not tick around it.

- [ ] **Hard iteration cap** — `MAX_ITERATIONS` / `budgets.maxLoops` enforced in `run-loop.sh`.
- [ ] **Wall-clock budget** — `budgets.wallClockMs` enforced; exit `2` on exceed.
- [ ] **Repeat-evidence stop** — the harness does not retry identical failures forever.
- [ ] **Maker/checker split** — the acting agent never decides completion; an exit code / validator does.
- [ ] **No-test-weakening rule** — the loop never weakens the gate to pass.
- [ ] **Receipts at exit** — `receipts.jsonl` is written on every termination path.
- [ ] **Escalation destination** — escalation is named in the contract (Escalation row).
- [ ] **Permission boundary** — the workspace/branch the loop acts in is explicit.

## Idempotent re-verify

Re-run the exact bounded smoke command — termination must be reproducible:

```bash
env MAX_ITERATIONS=2 LOOP_AGENT_CMD=.pi/loops/create-loop/stub-agent.sh \
  bash .pi/loops/create-loop/run-loop.sh
```

Then validate the receipts schema:

```bash
env MAX_ITERATIONS=2 node .pi/loops/create-loop/validate-receipts.mjs \
  .pi/artifacts/create-loop/receipts.jsonl
```

Record the final `smokeExitCode` (0 or 2) and `receiptCount` (number of lines
in `receipts.jsonl`) for the result payload.

## Exit-code convention reminder

**`0`** = exit condition met, **`2`** = budget exhausted — both valid bounded
terminations. `MAX_ITERATIONS` overrides the iteration cap; `LOOP_AGENT_CMD`
selects the agent.

## Gates at this step

- `create-loop--smoke-repeat` — command gate re-running the bounded smoke;
  `passOn` accepts exit codes `[0, 2]` (idempotent termination proof).
- `create-loop--receipts-schema` — command gate:
  `env MAX_ITERATIONS=2 node .pi/loops/create-loop/validate-receipts.mjs .pi/artifacts/create-loop/receipts.jsonl`
  — validates every receipt line parses as JSON with the required keys and the
  iteration count `<= MAX_ITERATIONS`.

Advance when the guardrail checklist is honestly complete and both gates pass.
