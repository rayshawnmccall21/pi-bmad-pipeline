/**
 * Group C — durable state, recovery, and concurrency filters.
 *
 * Covers resume identity binding, reconciliation after interruption, dispatch
 * lock contention and staleness, and the exactly-one-result invariant.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { computeRunDefDigest, loadRunDefFile } from "../../src/rundef/index.js";
import { createCanonicalRepositoryScope } from "../../src/security/final-scope-receipt.js";
import { createStageHandoff } from "../../src/security/stage-handoff.js";
import { getPipelineStateInvalidReason } from "../../src/state/fs-state-validation.js";
import {
  RUNNER_FEATURE_VERSION,
  type PipelineState,
  type StageState,
} from "../../src/state/index.js";
import {
  HAPPY_PIPELINE,
  builtCliPath,
  baseEnv,
  lockDirOf,
  makeProject,
  projectRoot,
  readState,
  runCli,
  singleResult,
  spawnMarkerPath,
  statePath,
  writePipeline,
} from "./harness.js";

const LEGACY_REVIEW_PIPELINE = `
id: legacy-review-recovery
stages:
  - id: dev-story
    kind: agent
    workflow: dev-story
    agent: dev
    timeout: 60
  - id: code-review
    kind: agent
    workflow: code-review
    agent: dev
    gate: code-review
    onFail: dev-story
    timeout: 60
  - id: docs
    kind: agent
    workflow: docs
    agent: architect
    timeout: 60
`;
const LEGACY_STORY_ID = "C7-LEGACY-REVIEW";
const LEGACY_BRANCH = "sty-144/recovery-e2e";
const CURRENT_REVIEW_STORY_ID = "C7-CURRENT-REVIEW";
const CURRENT_REVIEW_BRANCH = "sty-260/current-recovery-e2e";
const PRIOR_TIME = "2026-08-19T00:00:00.000Z";
const DISTINCTIVE_REVIEW_TIME = "2026-08-19T12:34:56.789Z";

interface StageSpawnTrace {
  readonly workflow: string;
  readonly attempt: number;
  readonly state: PipelineState;
}

const passedStage = (
  id: string,
  tokens: number,
  attempts = 1,
  finishedAt = PRIOR_TIME,
): StageState => ({
  id,
  status: "passed",
  attempts,
  startedAt: PRIOR_TIME,
  finishedAt,
  history: Array.from({ length: attempts }, (_, attemptIndex) => ({
    attempt: attemptIndex + 1,
    status: "passed" as const,
    startedAt: PRIOR_TIME,
    finishedAt: attemptIndex + 1 === attempts ? finishedAt : PRIOR_TIME,
    durationMs: 1,
    exitCode: 0,
    reason: `Prior ${id} pass.`,
    usage: { tokens, dollars: tokens / 10 },
  })),
  reason: `Prior ${id} pass.`,
});

const runGit = (root: string, args: readonly string[]): string => {
  const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
};

const waitUntil = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for built CLI state.");
    }
    await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 25));
  }
};

const writeLockInfo = (root: string, storyId: string, pid: number): void => {
  const lockDir = lockDirOf(root, storyId);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, "info.json"),
    JSON.stringify({ pid, runId: "held-by-test", startedAt: new Date().toISOString() }),
    "utf8",
  );
};

describe("durable state, recovery, and concurrency", () => {
  it("completes a single stage and persists the durable run record", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);

    const outcome = runCli(root, "happy", "C0-HAPPY");

    expect(outcome.stderr, outcome.stderr).toBe("");
    expect(outcome.status).toBe(0);
    expect(singleResult(outcome)).toMatchObject({ status: "passed", regressions: 0 });
    const state = readState(root, "C0-HAPPY");
    expect(state.storyId).toBe("C0-HAPPY");
    expect(state.status).toBe("done");
    expect(existsSync(lockDirOf(root, "C0-HAPPY"))).toBe(false);
  });

  it("resumes a second run against persisted state when identities match", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);

    expect(runCli(root, "happy", "C0-RESUME").status).toBe(0);
    const again = runCli(root, "happy", "C0-RESUME");
    expect(again.stderr, again.stderr).toBe("");
    expect(again.status).toBe(0);
    expect(singleResult(again)).toMatchObject({ status: "passed" });
  });

  it("backfills a current-version missing review checkpoint without spawning a stage", async () => {
    const root = makeProject();
    const pipelinePath = ".pi/bmad/pipelines/legacy-review-recovery.yaml";
    const reviewedPath = "src/reviewed.ts";
    const deletedPaths = ["src/deleted-source.ts", "tests/deleted-source.test.ts"];
    const defaultOnlyPath = ".pi/extensions/experts.ts";
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    for (const path of deletedPaths) {
      writeFileSync(join(root, path), `export const victim = ${JSON.stringify(path)};\n`, "utf8");
    }
    runGit(root, ["add", "--", ...deletedPaths]);
    runGit(root, ["commit", "-m", "seed tracked files before story fork"]);
    const forkOid = runGit(root, ["rev-parse", "HEAD"]);
    runGit(root, ["update-ref", "refs/remotes/origin/main", forkOid]);

    runGit(root, ["switch", "-c", CURRENT_REVIEW_BRANCH]);
    writePipeline(root, "legacy-review-recovery", LEGACY_REVIEW_PIPELINE);
    writeFileSync(join(root, reviewedPath), 'export const reviewed = "stable";\n', "utf8");
    runGit(root, ["add", "--", pipelinePath, reviewedPath]);
    runGit(root, ["commit", "-m", "seed current-version reviewed scope"]);
    const featureHeadOid = runGit(root, ["rev-parse", "HEAD"]);

    runGit(root, ["switch", "main"]);
    mkdirSync(join(root, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(root, defaultOnlyPath), 'export const defaultOnly = "later";\n', "utf8");
    runGit(root, ["add", "--", defaultOnlyPath]);
    runGit(root, ["commit", "-m", "advance default after story fork"]);
    const authenticatedDefaultTip = runGit(root, ["rev-parse", "HEAD"]);
    runGit(root, ["update-ref", "refs/remotes/origin/main", authenticatedDefaultTip]);
    expect(authenticatedDefaultTip).not.toBe(forkOid);
    expect(runGit(root, ["rev-parse", "refs/remotes/origin/main"])).toBe(authenticatedDefaultTip);
    expect(runGit(root, ["merge-base", authenticatedDefaultTip, featureHeadOid])).toBe(forkOid);

    runGit(root, ["switch", CURRENT_REVIEW_BRANCH]);
    runGit(root, ["rm", "--", ...deletedPaths]);

    const discovered = await loadRunDefFile(join(root, pipelinePath));
    const runDefDigest = computeRunDefDigest(discovered.runDef);
    const economics = { tokens: 18, dollars: 1.8 };
    const qualityGate = {
      stageId: "code-review",
      attempt: 3,
      status: "passed" as const,
      finishedAt: DISTINCTIVE_REVIEW_TIME,
    };
    const seedState: PipelineState = {
      runnerFeatureVersion: RUNNER_FEATURE_VERSION,
      storyId: CURRENT_REVIEW_STORY_ID,
      runDefId: "legacy-review-recovery",
      runDefDigest,
      specFile: "spec.md",
      status: "needs-attention",
      currentStage: null,
      stages: {
        "dev-story": passedStage("dev-story", 2),
        "code-review": passedStage("code-review", 5, 3, DISTINCTIVE_REVIEW_TIME),
        docs: passedStage("docs", 1),
      },
      regressions: 2,
      model: "gpt-5",
      thinking: "low",
      startedAt: PRIOR_TIME,
      finishedAt: null,
      economics,
    };
    expect(getPipelineStateInvalidReason(seedState)).toBeUndefined();
    mkdirSync(join(root, ".pi", "pipeline", "state"), { recursive: true });
    writeFileSync(
      statePath(root, CURRENT_REVIEW_STORY_ID),
      `${JSON.stringify(seedState, null, 2)}\n`,
    );
    const tracePath = join(root, ".pi", "pipeline", "current-review-trace.jsonl");

    const outcome = runCli(root, "legacy-review-recovery", CURRENT_REVIEW_STORY_ID, {
      E2E_STAGE_TRACE: tracePath,
    });

    expect(outcome.status, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
    expect(singleResult(outcome)).toMatchObject({
      status: "passed",
      stagesRun: [],
      regressions: seedState.regressions,
    });
    expect(existsSync(tracePath)).toBe(false);
    const finalState = readState(root, CURRENT_REVIEW_STORY_ID);
    expect(getPipelineStateInvalidReason(finalState)).toBeUndefined();
    expect(finalState).toMatchObject({
      status: "done",
      runnerFeatureVersion: RUNNER_FEATURE_VERSION,
    });
    expect(finalState.stages).toEqual(seedState.stages);
    expect(finalState.regressions).toBe(seedState.regressions);
    expect(finalState.economics).toEqual(seedState.economics);
    expect(finalState.reviewCheckpoint).toMatchObject({
      storyId: CURRENT_REVIEW_STORY_ID,
      runDefId: "legacy-review-recovery",
      runDefDigest,
      branch: CURRENT_REVIEW_BRANCH,
      baseOid: authenticatedDefaultTip,
      qualityGate,
    });
    expect(finalState.reviewCheckpoint?.qualityGate).toEqual(qualityGate);
    expect(finalState.reviewCheckpoint?.reviewed.paths).toEqual(
      [pipelinePath, reviewedPath, ...deletedPaths].sort(),
    );
    expect(finalState.reviewCheckpoint?.reviewed.paths).not.toContain(defaultOnlyPath);
    expect(finalState.finalScopeReceipt).toMatchObject({
      storyId: CURRENT_REVIEW_STORY_ID,
      runDefId: "legacy-review-recovery",
      runDefDigest,
      branch: CURRENT_REVIEW_BRANCH,
      baseOid: authenticatedDefaultTip,
      qualityGate,
    });
    expect(finalState.finalScopeReceipt?.qualityGate).toEqual(qualityGate);
    expect(finalState.finalScopeReceipt?.reviewed).toEqual(finalState.reviewCheckpoint?.reviewed);
  });

  it("reruns a durably passed legacy review before docs in a fresh process", async () => {
    const root = makeProject();
    runGit(root, ["switch", "-c", LEGACY_BRANCH]);
    writePipeline(root, "legacy-review-recovery", LEGACY_REVIEW_PIPELINE);
    mkdirSync(join(root, "src"), { recursive: true });
    const pipelinePath = ".pi/bmad/pipelines/legacy-review-recovery.yaml";
    const sourcePath = "src/current.ts";
    const priorSource = 'export const recoveryIdentity = "prior-review";\n';
    const currentSource = 'export const recoveryIdentity = "newly-reviewed";\n';
    writeFileSync(join(root, sourcePath), priorSource, "utf8");
    runGit(root, ["add", "--", pipelinePath, sourcePath]);
    runGit(root, ["commit", "-m", "seed previously reviewed bytes"]);

    const discovered = await loadRunDefFile(join(root, pipelinePath));
    const runDefDigest = computeRunDefDigest(discovered.runDef);
    const pipelineBytes = readFileSync(join(root, pipelinePath));
    const priorScope = createCanonicalRepositoryScope([
      { path: pipelinePath, bytes: pipelineBytes },
      { path: sourcePath, bytes: Buffer.from(priorSource) },
    ]);
    writeFileSync(join(root, sourcePath), currentSource, "utf8");
    const currentScope = createCanonicalRepositoryScope([
      { path: pipelinePath, bytes: pipelineBytes },
      { path: sourcePath, bytes: Buffer.from(currentSource) },
    ]);
    expect(currentScope.digest).not.toBe(priorScope.digest);

    const staleHandoff = createStageHandoff({ reviewed: priorScope, runId: "old-run" });
    expect(staleHandoff).toBeDefined();
    const economics = { tokens: 7, dollars: 0.7 };
    const seedState: PipelineState = {
      runnerFeatureVersion: 1,
      storyId: LEGACY_STORY_ID,
      runDefId: "legacy-review-recovery",
      runDefDigest,
      specFile: "spec.md",
      status: "running",
      currentStage: "code-review",
      stages: {
        "dev-story": passedStage("dev-story", 2),
        "code-review": passedStage("code-review", 5),
        docs: {
          id: "docs",
          status: "pending",
          attempts: 0,
          startedAt: null,
          finishedAt: null,
          history: [],
          upstreamHandoff: staleHandoff,
        },
      },
      regressions: 2,
      model: "gpt-5",
      thinking: "low",
      startedAt: PRIOR_TIME,
      finishedAt: null,
      economics,
    };
    expect(getPipelineStateInvalidReason(seedState)).toBeUndefined();
    expect(seedState).not.toHaveProperty("reviewCheckpoint");
    expect(seedState).not.toHaveProperty("finalScopeReceipt");
    mkdirSync(join(root, ".pi", "pipeline", "state"), { recursive: true });
    writeFileSync(statePath(root, LEGACY_STORY_ID), `${JSON.stringify(seedState, null, 2)}\n`);
    const tracePath = join(root, ".pi", "pipeline", "stage-trace.jsonl");

    const outcome = runCli(root, "legacy-review-recovery", LEGACY_STORY_ID, {
      E2E_STAGE_TRACE: tracePath,
    });

    expect(outcome.status, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
    expect(singleResult(outcome)).toMatchObject({
      status: "passed",
      stagesRun: ["code-review", "docs"],
      regressions: 2,
    });
    const traces = readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as StageSpawnTrace);
    expect(traces.map(({ workflow, attempt }) => ({ workflow, attempt }))).toEqual([
      { workflow: "code-review", attempt: 2 },
      { workflow: "docs", attempt: 1 },
    ]);

    const reviewStart = traces[0]!.state;
    expect(reviewStart).toMatchObject({
      storyId: seedState.storyId,
      runDefId: seedState.runDefId,
      runDefDigest: seedState.runDefDigest,
      specFile: seedState.specFile,
      model: seedState.model,
      thinking: seedState.thinking,
      regressions: 2,
      economics,
      runnerFeatureVersion: 1,
      status: "running",
      currentStage: "code-review",
    });
    expect(reviewStart.stages["dev-story"]).toEqual(seedState.stages["dev-story"]);
    expect(reviewStart.stages["code-review"]?.history).toEqual(
      seedState.stages["code-review"]?.history,
    );
    expect(reviewStart.stages.docs).not.toHaveProperty("upstreamHandoff");
    expect(reviewStart).not.toHaveProperty("reviewCheckpoint");

    const docsStart = traces[1]!.state;
    expect(docsStart.runnerFeatureVersion).toBe(2);
    expect(docsStart.regressions).toBe(2);
    expect(docsStart.economics).toEqual(economics);
    expect(docsStart.reviewCheckpoint).toMatchObject({
      storyId: LEGACY_STORY_ID,
      runDefId: "legacy-review-recovery",
      runDefDigest,
      branch: LEGACY_BRANCH,
      baseOid: runGit(root, ["rev-parse", "main"]),
      reviewed: currentScope,
      qualityGate: { stageId: "code-review", attempt: 2, status: "passed" },
    });
    expect(docsStart.reviewCheckpoint?.reviewed.digest).not.toBe(priorScope.digest);
    expect(docsStart.reviewCheckpoint?.runId).not.toBe("old-run");

    const finalState = JSON.parse(
      readFileSync(statePath(root, LEGACY_STORY_ID), "utf8"),
    ) as PipelineState;
    expect(finalState).toMatchObject({
      status: "done",
      runnerFeatureVersion: 2,
      regressions: 2,
      economics,
      storyId: seedState.storyId,
      runDefId: seedState.runDefId,
      runDefDigest: seedState.runDefDigest,
    });
    expect(finalState.stages["code-review"]?.attempts).toBe(2);
    expect(finalState.stages["code-review"]?.history[0]).toEqual(
      seedState.stages["code-review"]?.history[0],
    );
    expect(finalState.reviewCheckpoint).toEqual(docsStart.reviewCheckpoint);
    expect(finalState.finalScopeReceipt?.reviewed).toEqual(currentScope);
  });

  it("fails closed on resume identity mismatch without spawning a child", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);
    expect(runCli(root, "happy", "C1-MISMATCH").status).toBe(0);

    const statePathName = statePath(root, "C1-MISMATCH");
    const state = JSON.parse(readFileSync(statePathName, "utf8")) as { model: string };
    writeFileSync(statePathName, JSON.stringify({ ...state, model: "gpt-wrong" }), "utf8");
    const marker = spawnMarkerPath(root, "c1");

    const outcome = runCli(root, "happy", "C1-MISMATCH", { E2E_MARKER: marker });

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "needs-attention" });
    expect(outcome.stdout).toContain('"code":"state-identity-mismatch"');
    expect(existsSync(marker)).toBe(false);
  });

  it("reconciles an interrupted running stage and completes on rerun", async () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);

    const child = spawn(
      "node",
      [
        builtCliPath,
        "run",
        "happy",
        "--story-id",
        "C2-INTERRUPT",
        "--spec-file",
        "spec.md",
        "--project-root",
        root,
        "--jsonl",
      ],
      {
        cwd: projectRoot,
        env: { ...process.env, ...baseEnv, E2E_SLEEP_MS: "60000" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = new Promise<void>((resolveExit) => {
      child.on("close", () => resolveExit());
    });

    const stateFileName = statePath(root, "C2-INTERRUPT");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (existsSync(stateFileName)) {
        const snapshot = JSON.parse(readFileSync(stateFileName, "utf8")) as { status: string };
        if (snapshot.status === "running") {
          break;
        }
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
    }
    child.kill("SIGKILL");
    await exited;

    const rerun = runCli(root, "happy", "C2-INTERRUPT");
    expect(rerun.stderr, rerun.stderr).toBe("");
    expect(rerun.status).toBe(0);
    expect(singleResult(rerun)).toMatchObject({ status: "passed" });

    const state = readState(root, "C2-INTERRUPT");
    expect(state.status).toBe("done");
    expect(state.stages["dev"].status).toBe("passed");
    expect(state.stages["dev"].history.at(-1)?.status).toBe("passed");
    expect(existsSync(lockDirOf(root, "C2-INTERRUPT"))).toBe(false);
  });

  it.each([
    { name: "command", changedCommand: process.execPath, changedArgs: undefined },
    {
      name: "args",
      changedCommand: "node",
      changedArgs: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'changed')"],
    },
  ])("blocks changed code $name before a code spawn marker", ({ changedCommand, changedArgs }) => {
    const root = makeProject();
    const marker = spawnMarkerPath(root, "code-identity");
    const initialArgs = [
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], 'initial')",
      marker,
    ];
    const yaml = (command: string, args: readonly string[]): string => `
id: code-identity
stages:
  - id: check
    kind: code
    command: ${JSON.stringify(command)}
    args: ${JSON.stringify(args)}
    timeout: 60
`;

    writePipeline(root, "code-identity", yaml("node", initialArgs));
    expect(runCli(root, "code-identity", "C5-CODE-IDENTITY").status).toBe(0);
    rmSync(marker, { force: true });

    const nextArgs = changedArgs === undefined ? initialArgs : [...changedArgs, marker];
    writePipeline(root, "code-identity", yaml(changedCommand, nextArgs));
    const outcome = runCli(root, "code-identity", "C5-CODE-IDENTITY");

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "needs-attention" });
    expect(outcome.stdout).toContain('"code":"state-identity-mismatch"');
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "reruns an interrupted code stage without fabricating attempt history",
    async () => {
      const root = makeProject();
      const marker = spawnMarkerPath(root, "code-rerun");
      const pidFile = join(root, "code-rerun.pid");
      const script = `
const fs = require('node:fs');
const marker = ${JSON.stringify(marker)};
const count = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').length : 0;
fs.appendFileSync(marker, 'x');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
if (count === 0) setInterval(() => {}, 60000);
`;
      writePipeline(
        root,
        "code-rerun",
        `
id: code-rerun
stages:
  - id: check
    kind: code
    command: node
    args: ["-e", ${JSON.stringify(script)}]
    timeout: 60
`,
      );

      const cli = spawn(
        "node",
        [
          builtCliPath,
          "run",
          "code-rerun",
          "--story-id",
          "C6-CODE-RERUN",
          "--spec-file",
          "spec.md",
          "--project-root",
          root,
          "--jsonl",
        ],
        { cwd: projectRoot, env: { ...process.env, ...baseEnv }, stdio: "ignore" },
      );
      await waitUntil(
        () =>
          existsSync(pidFile) &&
          existsSync(statePath(root, "C6-CODE-RERUN")) &&
          readState(root, "C6-CODE-RERUN").stages["check"]?.status === "running",
      );

      cli.kill("SIGKILL");
      await new Promise<void>((resolveExit) => cli.once("close", () => resolveExit()));
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");

      const interrupted = readState(root, "C6-CODE-RERUN").stages["check"];
      expect(interrupted?.history).toHaveLength(0);
      expect(interrupted?.attempts).toBe(0);

      const rerun = runCli(root, "code-rerun", "C6-CODE-RERUN");
      expect(rerun.status).toBe(0);
      expect(readFileSync(marker, "utf8")).toBe("xx");
      const completed = readState(root, "C6-CODE-RERUN").stages["check"];
      expect(completed?.attempts).toBe(1);
      expect(completed?.history).toHaveLength(1);
      expect(completed?.history[0]?.status).toBe("passed");
    },
  );

  it("refuses a run when a live dispatch lock is held", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);
    writeLockInfo(root, "C3-LOCKED", process.pid);
    const marker = spawnMarkerPath(root, "c3");

    const outcome = runCli(root, "happy", "C3-LOCKED", { E2E_MARKER: marker });

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "needs-attention" });
    expect(outcome.stdout).toContain('"code":"lock-held"');
    expect(existsSync(marker)).toBe(false);
  });

  it("reclaims a stale dispatch lock held by a dead process", async () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);
    // Reap the child before writing the lock so its pid is no longer a live
    // zombie: kill(pid, 0) must report ESRCH for the staleness check.
    const dead = spawn("node", ["-e", "0"], { stdio: "ignore" });
    const deadPid = dead.pid as number;
    await new Promise<void>((resolveExit) => {
      dead.on("close", () => resolveExit());
    });
    writeLockInfo(root, "C4-STALE", deadPid);

    const outcome = runCli(root, "happy", "C4-STALE");

    expect(outcome.status).toBe(0);
    expect(singleResult(outcome)).toMatchObject({ status: "passed" });
    expect(existsSync(statePath(root, "C4-STALE"))).toBe(true);
  });
});
