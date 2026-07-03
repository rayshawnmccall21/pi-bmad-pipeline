# Bounded Smoke Run

Execute a bounded smoke run with the stub agent to prove the harness terminates
under budget and emits receipts. The methodology is the creating-loops skill
**`failure-modes.md`** (the infinite-loop guardrails) — read
`/Users/Apple/.pi/agent/skills/creating-loops/failure-modes.md` first. Every
named infinite-loop failure mode must be guarded by a concrete mechanism you can
point at in the harness (hard iteration cap, wall-clock budget, repeat-evidence
stop).

## Methodology source

- **Read**: `/Users/Apple/.pi/agent/skills/creating-loops/failure-modes.md`
  (infinite-loop guardrails: hard iteration cap, per-blocker retry budget,
  repeat-evidence stop, maker/checker split).

## Exit-code convention and env overrides

Two valid bounded-termination exit codes: **`0`** = exit condition met, **`2`**
= budget exhausted. The smoke gates accept both. The smoke run sets:

- `MAX_ITERATIONS=2` — bounds the loop to at most two iterations.
- `LOOP_AGENT_CMD=.pi/loops/create-loop/stub-agent.sh` — the deterministic stub.

## What to do

Run the bounded smoke exactly as the gate does:

```bash
env MAX_ITERATIONS=2 LOOP_AGENT_CMD=.pi/loops/create-loop/stub-agent.sh \
  bash .pi/loops/create-loop/run-loop.sh
```

Capture the observed exit code. It MUST be `0` or `2` — any other code is an
unbounded/abnormal termination and means the harness is wrong; fix the harness,
do not advance. Confirm `.pi/artifacts/create-loop/receipts.jsonl` was created
and contains at least one JSON line with the keys `iteration`, `timestamp`,
`action`, `outcome`, `exitCode`.

Record the observed exit code for the final result payload (`smokeExitCode`).

## Gates at this step

- `create-loop--smoke-bounded` — command gate running the bounded smoke;
  `passOn` accepts exit codes `[0, 2]` (both valid bounded terminations).
- `create-loop--receipts-exist` — command gate: `test -s` confirms
  `receipts.jsonl` is non-empty.

Advance when the smoke run terminated with exit `0` or `2` and receipts were
emitted.
