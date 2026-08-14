/**
 * Group A — child-boundary fail-closed filters.
 *
 * Every envelope/jail path the supervisor must reject is triggered through the
 * built CLI, and each assertion pins the exact decision kind and failure
 * reason so a passing suite proves the fail-closed contract, not merely "no
 * crash".
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  HAPPY_PIPELINE,
  TIMEOUT_PIPELINE,
  makeProject,
  readState,
  runCli,
  singleResult,
  spawnMarkerPath,
  startCli,
  writePipeline,
} from "./harness.js";
import { buildTerminalEnvelope } from "./stub-pi.mjs";

const firstAttempt = (root: string, storyId: string, stageId = "dev") => {
  const state = readState(root, storyId);
  const history = state.stages[stageId]?.history ?? [];
  const attempt = history[0];
  expect(attempt, `missing first attempt for stage ${stageId}`).toBeDefined();
  return attempt as NonNullable<typeof attempt>;
};

const settlementBoundMs = 15_000;
const processPollMs = 25;

interface ProcessTreeMarker {
  readonly parentPid: number;
  readonly descendantPid: number;
}

const descendantPipeline = (markerPath: string): string => {
  const descendant = `
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;
  const parent = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ parentPid: process.pid, descendantPid: child.pid }));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;
  return `
id: descendant-cleanup
stages:
  - id: code
    kind: code
    command: node
    args: ["-e", ${JSON.stringify(parent)}]
    timeout: 1
`;
};

const waitForProcessTree = async (markerPath: string): Promise<ProcessTreeMarker> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) {
      return JSON.parse(readFileSync(markerPath, "utf8")) as ProcessTreeMarker;
    }
    await delay(processPollMs);
  }
  throw new Error(`process tree did not write marker ${markerPath}`);
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const expectProcessDead = async (pid: number): Promise<void> => {
  const deadline = Date.now() + settlementBoundMs;
  while (Date.now() < deadline && processIsAlive(pid)) {
    await delay(processPollMs);
  }
  expect(processIsAlive(pid), `descendant ${pid} survived process-group cleanup`).toBe(false);
};

const killLeakedGroup = (tree: ProcessTreeMarker | undefined): void => {
  if (tree === undefined || !processIsAlive(tree.descendantPid)) return;
  try {
    process.kill(-tree.parentPid, "SIGKILL");
  } catch {
    // The group may exit between the liveness check and cleanup.
  }
};

describe("child boundary fails closed", () => {
  it("keeps the stub envelope contract in sync with the requested story", () => {
    const envelope = buildTerminalEnvelope({
      workflow: "dev-story",
      storyId: "E2E-STORY",
      attempt: 1,
    });

    expect(envelope).toMatchObject({
      schemaVersion: "pi-bmad.headless-workflow-result.v1",
      workflow: "dev-story",
      returnType: "pi-bmad.workflow.dev-story.result.v1",
    });
    expect(envelope.payload).toMatchObject({ storyId: "E2E-STORY" });
  });

  it("rejects a malformed JSONL line as a parse error", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);

    const outcome = runCli(root, "happy", "A1-GARBAGE", { E2E_GARBAGE: "1" });

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed" });
    const attempt = firstAttempt(root, "A1-GARBAGE");
    expect(attempt.status).toBe("parse-error");
    expect(attempt.parseError).toContain("Invalid JSONL");
  });

  it("rejects empty child stdout as missing terminal output", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);

    const outcome = runCli(root, "happy", "A2-SILENT", { E2E_SILENT: "1" });

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed" });
    const attempt = firstAttempt(root, "A2-SILENT");
    expect(attempt.status).toBe("parse-error");
    expect(attempt.parseError).toContain("No headless terminal output found");
  });

  it("rejects a non-terminal event stream as missing terminal output", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);

    const outcome = runCli(root, "happy", "A3-NO-ENVELOPE", { E2E_NO_ENVELOPE: "1" });

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed" });
    const attempt = firstAttempt(root, "A3-NO-ENVELOPE");
    expect(attempt.status).toBe("parse-error");
    expect(attempt.parseError).toContain("No headless terminal output found");
  });

  it("rejects an unsigned envelope at the provenance gate", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);

    const outcome = runCli(root, "happy", "A4-FORGE", { E2E_FORGE: "1" });

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed" });
    const attempt = firstAttempt(root, "A4-FORGE");
    expect(attempt.status).toBe("parse-error");
    expect(attempt.parseError).toContain("provenance gate");
  });

  it("rejects an envelope stamped with a forged engine marker", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);

    const outcome = runCli(root, "happy", "A5-MARKER", { E2E_BAD_MARKER: "1" });

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed" });
    expect(firstAttempt(root, "A5-MARKER").status).toBe("parse-error");
  });

  it("rejects an envelope with a malformed signature", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);

    const outcome = runCli(root, "happy", "A6-SIG", { E2E_BAD_SIG: "1" });

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed" });
    expect(firstAttempt(root, "A6-SIG").status).toBe("parse-error");
  });

  it("rejects an envelope signed under a different emission key", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);

    const outcome = runCli(root, "happy", "A7-KEY", { E2E_WRONG_KEY: "1" });

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed" });
    expect(firstAttempt(root, "A7-KEY").status).toBe("parse-error");
  });

  it("rejects a verified envelope emitted for a different workflow", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);

    const outcome = runCli(root, "happy", "A8-WORKFLOW", { E2E_WRONG_WORKFLOW: "1" });

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed" });
    const attempt = firstAttempt(root, "A8-WORKFLOW");
    expect(attempt.status).toBe("parse-error");
    expect(attempt.parseError).toContain("custom-e2e-workflow");
    expect(attempt.parseError).toContain("dev-story");
  });

  it("fails a nonzero exit even when the envelope is valid", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);

    const outcome = runCli(root, "happy", "A9-EXIT", { E2E_EXIT: "7" });

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed" });
    const attempt = firstAttempt(root, "A9-EXIT");
    expect(attempt.status).toBe("failed");
    expect(attempt.reason).toContain("exited with code 7");
  });

  it("surfaces child stderr when a nonzero exit carries no envelope", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);

    const outcome = runCli(root, "happy", "A10-STDERR", {
      E2E_EXIT: "7",
      E2E_SILENT: "1",
      E2E_STDERR: "boom",
    });

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed" });
    const attempt = firstAttempt(root, "A10-STDERR");
    expect(attempt.status).toBe("parse-error");
    expect(attempt.parseError).toContain("Child stderr:");
    expect(attempt.parseError).toContain("boom");
  });

  it("caps captured child stderr at MAX_STAGE_STDERR_CHARS", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);

    const outcome = runCli(root, "happy", "A11-CAP", {
      E2E_EXIT: "1",
      E2E_SILENT: "1",
      E2E_STDERR_CHARS: "20000",
    });

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed" });
    const parseError = firstAttempt(root, "A11-CAP").parseError ?? "";
    expect(parseError).toHaveLength("Child stderr: ".length + 16_384);
  });

  it("runs code with literal argv, project-root cwd, inherited env, and discarded output", () => {
    const root = makeProject();
    const marker = spawnMarkerPath(root, "code-contract");
    const shellSideEffect = spawnMarkerPath(root, "shell-side-effect");
    const script = `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  cwd: process.cwd(),
  sentinel: process.env.E2E_CODE_SENTINEL,
  args: process.argv.slice(1),
}));
process.stdout.write('SUCCESS_OUTPUT_MUST_BE_DISCARDED');
`;
    const literalArgs = ["space value", `$(touch ${shellSideEffect})`];
    writePipeline(
      root,
      "code-contract",
      `
id: code-contract
stages:
  - id: check
    kind: code
    command: node
    args: ["-e", ${JSON.stringify(script)}, ${literalArgs.map((argument) => JSON.stringify(argument)).join(", ")}]
    timeout: 60
`,
    );

    const outcome = runCli(root, "code-contract", "A13-CODE-CONTRACT", {
      E2E_CODE_SENTINEL: "inherited",
    });
    const observed = JSON.parse(readFileSync(marker, "utf8")) as {
      cwd: string;
      sentinel: string;
      args: string[];
    };

    expect(outcome.status).toBe(0);
    expect(singleResult(outcome)).toMatchObject({ status: "passed" });
    expect(observed).toEqual({ cwd: realpathSync(root), sentinel: "inherited", args: literalArgs });
    expect(existsSync(shellSideEffect)).toBe(false);
    expect(outcome.stdout).not.toContain("SUCCESS_OUTPUT_MUST_BE_DISCARDED");
  });

  it("records a timed-out stage when the child exceeds the stage timeout", () => {
    const root = makeProject();
    writePipeline(root, "timeout", TIMEOUT_PIPELINE);

    const outcome = runCli(root, "timeout", "A12-TIMEOUT", { E2E_SLEEP_MS: "5000" });

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed" });
    expect(firstAttempt(root, "A12-TIMEOUT").status).toBe("timed-out");
  });
});

describe.skipIf(process.platform === "win32")("code process-group cleanup", () => {
  it("kills a SIGTERM-ignoring descendant and settles after stage timeout", async () => {
    const root = makeProject();
    const markerPath = spawnMarkerPath(root, "timeout-descendant");
    writePipeline(root, "descendant-cleanup", descendantPipeline(markerPath));

    let tree: ProcessTreeMarker | undefined;
    try {
      const startedAt = Date.now();
      const running = startCli(root, "descendant-cleanup", "A14-CODE-TIMEOUT");
      tree = await waitForProcessTree(markerPath);
      const outcome = await running.outcome;

      expect(Date.now() - startedAt).toBeLessThan(settlementBoundMs);
      expect(outcome.status).toBe(2);
      expect(singleResult(outcome)).toMatchObject({ status: "failed" });
      expect(firstAttempt(root, "A14-CODE-TIMEOUT", "code").status).toBe("timed-out");
      await expectProcessDead(tree.descendantPid);
    } finally {
      killLeakedGroup(tree);
    }
  });

  it("forwards external abort and kills a SIGTERM-ignoring descendant", async () => {
    const root = makeProject();
    const markerPath = spawnMarkerPath(root, "abort-descendant");
    writePipeline(root, "descendant-cleanup", descendantPipeline(markerPath));

    let tree: ProcessTreeMarker | undefined;
    try {
      const running = startCli(root, "descendant-cleanup", "A15-CODE-ABORT");
      tree = await waitForProcessTree(markerPath);
      const abortedAt = Date.now();
      expect(running.child.kill("SIGTERM")).toBe(true);
      const outcome = await running.outcome;

      expect(Date.now() - abortedAt).toBeLessThan(settlementBoundMs);
      expect(outcome.status).toBe(2);
      expect(singleResult(outcome)).toMatchObject({ status: "needs-attention" });
      expect(firstAttempt(root, "A15-CODE-ABORT", "code").status).toBe("aborted");
      await expectProcessDead(tree.descendantPid);
    } finally {
      killLeakedGroup(tree);
    }
  });
});
