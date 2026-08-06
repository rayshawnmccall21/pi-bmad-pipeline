# Story: Strip pi-bmad-pipeline to its unix core — YAML-defined FSM execution only

## Summary

pi-bmad-pipeline must do exactly one thing well: **execute an FSM defined by a
YAML rundef**, supervising one hermetic pi child per stage with durable,
resumable state. Every capability that is not required for that is deleted.
The built-in SDLC pipeline is removed entirely — pipeline definitions come
ONLY from discovered YAML (`.pi/bmad/pipelines/*.yaml`). Policy that was code
(verification, PR opening, auditing) becomes the user's YAML stages or
external tools reading the durable JSON state.

## Unix philosophy mandate (governs every decision)

1. Each module does ONE thing well; no god modules.
2. Compose via minimal interfaces; text/JSON streams and exit codes at process boundaries.
3. No hidden shared mutable state; dependencies explicit and injected.
4. Fail closed with typed machine-readable errors.
5. Mechanism (FSM, spawning, state) stays; policy (which stages, what gates mean for a
   product) lives in YAML and in the workflows the stages run.
6. Single source of truth; deleting a capability means deleting ALL of it.
7. The durable state file IS the audit surface; the JSONL event stream IS the API.

## DELETE — files removed entirely (with their tests)

- `src/rundef/builtin.ts`, `src/rundef/builtin.test.ts` — no built-in rundefs of any kind
- `src/rundef/ext-resolve.ts`, `src/rundef/ext-resolve.test.ts` — unwired stage-extension paths
- `src/contracts/` — the entire module (dormant seam; the executor validates via
  pi-bmad/contracts directly, which stays)
- `src/git/story-pull-request.ts`, `src/git/merge-gate.ts`, `src/git/secret-scan.ts` + tests
  (KEEP `src/git/worktrees.ts` and `src/git/worktree-registry.ts` — worktree isolation is core)
- `src/state/current-run-store.ts` + test (its only purpose fed the deleted merge flow)
- `src/security/harness-evidence.ts`, `harness-evidence-command.ts`,
  `harness-evidence-store.ts` + tests (KEEP `src/security/redaction.ts` — output boundary mechanism)
- `src/audit/` — the entire module (durable state JSON is greppable/jq-able; that is the audit)

## MODIFY — trims required by the deletions

- `src/rundef/selector.ts`: discovered-YAML-only resolution. Remove every builtin branch,
  the builtin/discovered conflict path, and now-unused error codes. `selectRunDef` /
  `selectAndCompileRunDef` resolve from `discoverRunDefs` alone; unknown id fails closed
  with `rundef-not-found`.
- `src/actions/` (run-pipeline-action, -execution, -settlement): the action becomes
  lock → load/reconcile-or-init state → ensure worktree → register payload gates →
  select+compile YAML rundef → resolve model → run FSM (durable saveState + events) →
  final state + result event → release lock. Remove evidence, PR (`openPr`), and audit
  wiring and their request fields/deps entirely.
- `src/cli.ts` / `src/cli-args.ts` / `src/cli-command.ts` / `src/cli-output.ts`:
  commands are exactly `run | help | version`. Delete `audit`, `iso`, `merge` grammars,
  types, executors, and now-dead deps (loadEvidence, loadCurrentRun, generateAudit,
  ensureWorktree-as-command, evaluateMerge, compileStages-for-audit). Delete the
  `--no-pr` flag (there is no PR capability). `run <rundef-id>` stays required-positional.
- `src/events/pipeline-event.ts`: delete the `evidence.finished`, `pr.opened`, and
  `merge.decision` variants (nothing can emit them). Keep run/stage/gate/budget/
  progress/result/error.
- `src/executors/pi/`: remove the stage-extension plumbing end to end
  (`stageExtensionPath` on requests/argv builder, `resolveStageExtensionPath` executor
  option, the second `-e` slot). Everything else stays byte-for-byte.
- `src/index.ts` barrel and every module barrel: export only what still exists. knip
  must be clean — treat every knip finding as a deletion instruction, not an ignore.
- `package.json`: update `description` to the narrowed mission. Do not touch deps
  (`pi-bmad`, `typebox`, `yaml` are all still load-bearing).
- `.gitignore`: add `.pi/pipeline/` (durable state/locks/worktrees of self-supervision runs).
- `CONTEXT.md`: rewrite §the-parts-that-changed to describe the narrowed mission
  (docs stage owns this).

## ADD

- `.pi/bmad/pipelines/sdlc.yaml`: the former builtin, now data (id `sdlc`, the six
  agent stages with their gates/onFail/thinking/timeouts exactly as the builtin had).
  This is an EXAMPLE and the self-supervision definition — the capability moves from
  code to YAML, it does not vanish.
- A loader/selector test proving `.pi/bmad/pipelines/sdlc.yaml` is discovered and
  compiles against the registered gates.

## KEEP — the irreducible core (do not touch beyond the trims above)

rundef (schema/types/compile/loader/selector/registry), core (pipeline-runner,
runner-evaluation, runner-transitions, stage-decision, routing, budgets), state
(pipeline-state, fs-state-store, fs-state-validation, dispatch-lock, state-reconcile),
executors/pi (spawn seam, argv builder, JSONL parser, emission-key gating, debug events),
gates (contract-true e2e-verify + code-review payload gates and the registry — YAML
rundefs reference gates by name; without them `gate:` fails compilation), model
(model-config), events (pipeline-event minus deleted variants, debug-log), git
(worktrees, worktree-registry), security (redaction), cli (run/help/version), actions
(slimmed composition root), meta.ts, index barrels.

## OUT OF SCOPE — do not touch

- Locked files: `eslint.config.js`, `.prettierrc*`, `vitest.config.ts`, `knip.json`,
  `tsconfig*.json`, `scripts/crap-*.mjs`, `CLAUDE.md`.
- `.pi/workflows/`, `.pi/loops/`, `src/checkpoints/`, `tests/checkpoint-conformance.test.ts`,
  `vitest.conformance.config.ts` — the checkpoint meta-layer is a separate decision.
- `dist/` (regenerated), `quality/` (ratchet baseline may be regenerated via
  `npm run crap:update-baseline` ONLY if function count shrinks, never to admit worse scores).

## Acceptance criteria

1. `npm run check` exits 0 in the worktree (typecheck, prettier, eslint, coverage ≥90%,
   CRAP ≤5, conformance, knip) — knip with ZERO findings and no config changes.
2. `grep -rn "SDLC_RUNDEF\|resolveBuiltinRunDef\|BUILTIN_RUNDEF\|openStoryPullRequest\|evaluateMergeGate\|scanGitDiffForSecrets\|runHarnessEvidence\|saveHarnessEvidence\|generatePipelineAuditReport\|saveCurrentRunPointer\|stageExtensionPath" src/` returns NOTHING.
3. `src/rundef/builtin.ts`, `src/audit/`, `src/contracts/`, the three deleted git files,
   the three deleted security files, and `src/state/current-run-store.ts` do not exist.
4. `.pi/bmad/pipelines/sdlc.yaml` exists, is discovered by the loader, and compiles
   with the registered gates (proven by a test).
5. CLI: `run` works against a discovered YAML id; `audit`, `iso`, `merge` are unknown
   commands; usage text lists only `run | help | version`.
6. Every commit made in the worktree is a focused conventional commit (deletions may be
   grouped by subsystem). The dev stage MUST `git add`/`git commit` its work — do not
   leave the worktree dirty.
7. No test is weakened to pass: tests of deleted code are deleted with it; tests of kept
   code keep their assertions.
