/**
 * Shared driver for the built-CLI end-to-end mechanism suite.
 *
 * Every test spawns the bundled `dist/src/cli.js` as a real child process
 * against a throwaway project root and observes the four external channels:
 * CLI exit code, JSONL event stream, durable state file, and lock directory.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect } from "vitest";

const require = createRequire(import.meta.url);

/** Package root of the pipeline repository. */
export const projectRoot = resolve(import.meta.dirname, "../..");

/** Built CLI entry produced by `npm run build`. */
export const builtCliPath = join(projectRoot, "dist", "src", "cli.js");

/** Absolute path of the stub Pi child. */
const stubPath = join(import.meta.dirname, "stub-pi.mjs");

/** Real pi-bmad extension path (schema root for payload validation). */
const extensionPath = require.resolve("pi-bmad/extension");

/** Base env every spawned CLI receives. */
export const baseEnv: Readonly<Record<string, string>> = Object.freeze({
  BMAD_PIPELINE_MODEL: "gpt-5",
  BMAD_PIPELINE_THINKING: "low",
  BMAD_PIPELINE_PI_BIN: stubPath,
  PI_BMAD_PIPELINE_EXTENSION_PATH: extensionPath,
});

/** Single-stage happy-path pipeline. */
export const HAPPY_PIPELINE = `
id: happy
stages:
  - id: dev
    kind: agent
    workflow: dev-story
    agent: dev
    timeout: 60
`;

/** Three-stage ordering pipeline. */
export const ORDERED_PIPELINE = `
id: ordered
stages:
  - id: alpha
    kind: agent
    workflow: dev-story
    agent: dev
    timeout: 60
  - id: beta
    kind: agent
    workflow: dev-story
    agent: dev
    timeout: 60
  - id: gamma
    kind: agent
    workflow: dev-story
    agent: dev
    timeout: 60
`;

/** Gated pipeline with an earlier-stage regression target. */
export const REGRESSION_PIPELINE = `
id: regression
stages:
  - id: dev
    kind: agent
    workflow: dev-story
    agent: dev
    timeout: 60
  - id: verify
    kind: agent
    workflow: e2e-verify
    agent: tea
    gate: e2e-verify
    onFail: dev
    timeout: 60
`;

/** Single gated stage with no regression target. */
// REMOVED: the RunDef schema requires gate/onFail pairing, so a gate without
// an onFail target never compiles; gate-failure-without-regression is covered
// through the regression pipeline + a regression ceiling.

/** Stage with a token budget exhausted by the usage-reporting stub. */
export const BUDGET_PIPELINE = `
id: budget
stages:
  - id: dev
    kind: agent
    workflow: dev-story
    agent: dev
    budget:
      maxTokens: 1
    timeout: 60
`;

/** Stage with a one-second timeout for SIGTERM kill tests. */
export const TIMEOUT_PIPELINE = `
id: timeout
stages:
  - id: dev
    kind: agent
    workflow: dev-story
    agent: dev
    timeout: 1
`;

const tempRoots: string[] = [];

/** Creates a fresh project root with the pipeline directory and spec file. */
export const makeProject = (): string => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-e2e-"));
  tempRoots.push(root);
  mkdirSync(join(root, ".pi", "bmad", "pipelines"), { recursive: true });
  writeFileSync(join(root, "spec.md"), "# E2E story spec\n", "utf8");
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "pipeline-e2e@example.com"],
    ["config", "user.name", "Pipeline E2E"],
    ["add", "spec.md"],
    ["commit", "-m", "seed"],
    ["update-ref", "refs/remotes/origin/main", "HEAD"],
    ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`Failed to initialize E2E Git fixture: ${result.stderr}`);
    }
  }
  return root;
};

/** Writes one discovered pipeline YAML into a project root. */
export const writePipeline = (root: string, id: string, yaml: string): void => {
  writeFileSync(join(root, ".pi", "bmad", "pipelines", `${id}.yaml`), yaml, "utf8");
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Captured outcome of one spawned CLI process. */
interface RunOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Running built CLI and its eventual captured outcome. */
interface RunningCli {
  readonly child: ChildProcess;
  readonly outcome: Promise<RunOutcome>;
}

const spawnCli = (
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): SpawnSyncReturns<string> =>
  spawnSync("node", [...args], {
    cwd: projectRoot,
    env: { ...process.env, ...baseEnv, ...env },
    encoding: "utf8",
  });

/**
 * Runs the built CLI synchronously and returns the outcome.
 *
 * @param root - Project root passed via --project-root.
 * @param rundefId - RunDef id to select.
 * @param storyId - Active story id.
 * @param extraEnv - Additional child-cli environment (stub knobs, CLI seams).
 * @param extraArgs - Additional CLI argument tokens.
 * @param jsonl - Emit raw JSONL events when true, human-formatted otherwise.
 */
export const runCli = (
  root: string,
  rundefId: string,
  storyId: string,
  extraEnv: Readonly<Record<string, string>> = {},
  extraArgs: readonly string[] = [],
  jsonl = true,
): RunOutcome => {
  const result = spawnCli(
    [
      builtCliPath,
      "run",
      rundefId,
      "--story-id",
      storyId,
      "--spec-file",
      "spec.md",
      "--project-root",
      root,
      ...(jsonl ? ["--jsonl"] : []),
      ...extraArgs,
    ],
    extraEnv,
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/**
 * Runs an arbitrary CLI argv (help, version, parse-error paths) and returns
 * the outcome.
 *
 * @param args - CLI tokens after the built binary path.
 * @param extraEnv - Additional child-cli environment.
 */
/** Starts the built CLI asynchronously so tests can send an external abort signal. */
export const startCli = (
  root: string,
  rundefId: string,
  storyId: string,
  extraEnv: Readonly<Record<string, string>> = {},
): RunningCli => {
  const child = spawn(
    "node",
    [
      builtCliPath,
      "run",
      rundefId,
      "--story-id",
      storyId,
      "--spec-file",
      "spec.md",
      "--project-root",
      root,
      "--jsonl",
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, ...baseEnv, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const outcome = new Promise<RunOutcome>((resolveOutcome, rejectOutcome) => {
    child.once("error", rejectOutcome);
    child.once("close", (status) => {
      resolveOutcome({ status, stdout, stderr });
    });
  });
  return { child, outcome };
};

export const runRaw = (
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): RunOutcome => {
  const result = spawnCli([builtCliPath, ...args], extraEnv);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/** Parses result records (event === "result") from a JSONL outcome. */
const resultRecords = (outcome: RunOutcome): Record<string, unknown>[] =>
  outcome.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record["event"] === "result");

/** Asserts the run emitted exactly one result record and returns it. */
export const singleResult = (outcome: RunOutcome): Record<string, unknown> => {
  const records = resultRecords(outcome);
  expect(records).toHaveLength(1);
  return records[0] ?? {};
};

/** Parsed durable state file for a story. */
interface DurableState {
  readonly storyId: string;
  readonly status: string;
  readonly regressions: number;
  readonly model: string;
  readonly stages: Record<string, StageState>;
}

/** Durable per-stage state with attempt history. */
interface StageState {
  readonly status: string;
  readonly attempts: number;
  readonly history: readonly StageAttempt[];
}

/** Durable per-attempt record. */
interface StageAttempt {
  readonly attempt: number;
  readonly status: string;
  readonly reason?: string;
  readonly parseError?: string;
  readonly exitCode?: number;
  readonly findings?: readonly string[];
}

export const statePath = (root: string, storyId: string): string =>
  join(root, ".pi", "pipeline", "state", `${storyId}.json`);

/** Reads and structuralizes the durable state file for a story. */
export const readState = (root: string, storyId: string): DurableState => {
  const raw = JSON.parse(readFileSync(statePath(root, storyId), "utf8")) as {
    storyId: string;
    status: string;
    regressions: number;
    model: string;
    stages: Record<string, StageState>;
  };
  return raw;
};

export const lockDirOf = (root: string, storyId: string): string =>
  join(root, ".pi", "pipeline", "locks", storyId);

/** Marker path a stub child writes when spawned (no-spawn assertions). */
export const spawnMarkerPath = (root: string, name: string): string => join(root, `${name}.marker`);
