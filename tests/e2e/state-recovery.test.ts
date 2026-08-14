/**
 * Group C — durable state, recovery, and concurrency filters.
 *
 * Covers resume identity binding, reconciliation after interruption, dispatch
 * lock contention and staleness, and the exactly-one-result invariant.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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
