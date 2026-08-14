/**
 * Group B — FSM routing and gate filters.
 *
 * Exercises stage decisions, payload gates, regression routing, regression
 * ceilings, stage budgets, stage ordering, and the compile-before-spawn rule
 * through the built CLI.
 */
import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BUDGET_PIPELINE,
  ORDERED_PIPELINE,
  REGRESSION_PIPELINE,
  makeProject,
  readState,
  runCli,
  singleResult,
  spawnMarkerPath,
  writePipeline,
} from "./harness.js";

const verifyAttempts = (
  root: string,
  storyId: string,
): { readonly status: string; readonly reason?: string }[] => {
  const state = readState(root, storyId);
  const history = state.stages["verify"]?.history ?? [];
  expect(history.length, "verify stage never ran").toBeGreaterThan(0);
  return history;
};

describe("FSM routing and gates", () => {
  it("retries a gate-failed stage once and passes on the second attempt", () => {
    const root = makeProject();
    writePipeline(root, "regression", REGRESSION_PIPELINE);

    const outcome = runCli(root, "regression", "B0-RETRY");

    expect(outcome.stderr, outcome.stderr).toBe("");
    expect(outcome.status).toBe(0);
    const result = singleResult(outcome);
    expect(result).toMatchObject({ status: "passed" });
    expect(Number(result["regressions"])).toBeGreaterThanOrEqual(1);

    const state = readState(root, "B0-RETRY");
    expect(state.stages["dev"].attempts).toBeGreaterThanOrEqual(2);
    const history = verifyAttempts(root, "B0-RETRY");
    expect(history[0]?.status).toBe("gate-failed");
    expect(history.at(-1)?.status).toBe("passed");
  });

  it("fails the run when the regression ceiling is zero", () => {
    const root = makeProject();
    writePipeline(root, "regression", REGRESSION_PIPELINE);

    const outcome = runCli(root, "regression", "B1-CEILING", {}, ["--max-regressions", "0"]);

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed", regressions: 0 });
    const history = verifyAttempts(root, "B1-CEILING");
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("gate-failed");
  });

  it("fails the run after regressions when the gate keeps failing", () => {
    const root = makeProject();
    writePipeline(root, "regression", REGRESSION_PIPELINE);

    const outcome = runCli(root, "regression", "B2-KEEPS-FAILING", { E2E_FAIL_ALWAYS: "1" }, [
      "--max-regressions",
      "1",
    ]);

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed", regressions: 1 });
    const history = verifyAttempts(root, "B2-KEEPS-FAILING");
    expect(history).toHaveLength(2);
    expect(history.every((attempt) => attempt.status === "gate-failed")).toBe(true);
  });

  it("fails closed when a pass verdict contradicts scenario failures", () => {
    const root = makeProject();
    writePipeline(root, "regression", REGRESSION_PIPELINE);

    const outcome = runCli(root, "regression", "B3-CONTRADICT", { E2E_CONTRADICT: "1" }, [
      "--max-regressions",
      "0",
    ]);

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed" });
    const attempt = verifyAttempts(root, "B3-CONTRADICT")[0];
    expect(attempt?.status).toBe("gate-failed");
    expect(attempt?.reason).toMatch(/contradict/iu);
  });

  it("fails closed when the payload belongs to another story", () => {
    const root = makeProject();
    writePipeline(root, "regression", REGRESSION_PIPELINE);

    const outcome = runCli(root, "regression", "B4-WRONG-STORY", { E2E_WRONG_STORY: "1" }, [
      "--max-regressions",
      "0",
    ]);

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed" });
    const attempt = verifyAttempts(root, "B4-WRONG-STORY")[0];
    expect(attempt?.status).toBe("gate-failed");
    expect(attempt?.reason).toContain("story identity");
  });

  it("halts the run when a stage exceeds its token budget", () => {
    const root = makeProject();
    writePipeline(root, "budget", BUDGET_PIPELINE);
    const marker = spawnMarkerPath(root, "b5");

    const outcome = runCli(root, "budget", "B5-BUDGET", {
      E2E_USAGE: "1",
      E2E_MARKER: marker,
    });

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "needs-attention" });
    // The child executed and reported usage; only the budget halted the run.
    expect(existsSync(marker)).toBe(true);
  });

  it("executes stages in declared order and passes all of them", () => {
    const root = makeProject();
    writePipeline(root, "ordered", ORDERED_PIPELINE);

    const outcome = runCli(root, "ordered", "B6-ORDER");

    expect(outcome.status).toBe(0);
    const result = singleResult(outcome);
    expect(result).toMatchObject({ status: "passed" });
    expect(result["stagesRun"]).toEqual(["alpha", "beta", "gamma"]);
    for (const stageId of ["alpha", "beta", "gamma"]) {
      expect(readState(root, "B6-ORDER").stages[stageId]?.status).toBe("passed");
    }
  });

  it("executes mixed agent, code, agent stages in declared order", () => {
    const root = makeProject();
    writePipeline(
      root,
      "mixed",
      `
id: mixed
stages:
  - id: alpha
    kind: agent
    workflow: dev-story
    agent: dev
    timeout: 60
  - id: check
    kind: code
    command: node
    args: ["-e", "process.stdout.write('discarded')"]
    timeout: 60
  - id: omega
    kind: agent
    workflow: dev-story
    agent: dev
    timeout: 60
`,
    );

    const outcome = runCli(root, "mixed", "B7-MIXED");

    expect(outcome.stderr, outcome.stderr).toBe("");
    expect(outcome.status, outcome.stdout).toBe(0);
    expect(singleResult(outcome)["stagesRun"]).toEqual(["alpha", "check", "omega"]);
  });

  it("stops terminally when a code stage exits nonzero", () => {
    const root = makeProject();
    writePipeline(
      root,
      "code-failure",
      `
id: code-failure
stages:
  - id: check
    kind: code
    command: node
    args: ["-e", "process.stderr.write('check failed'); process.exit(3)"]
    timeout: 60
  - id: never
    kind: agent
    workflow: docs
    agent: architect
    timeout: 60
`,
    );

    const outcome = runCli(root, "code-failure", "B8-CODE-FAIL");

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({
      status: "failed",
      regressions: 0,
      stagesRun: ["check"],
    });
    expect(readState(root, "B8-CODE-FAIL").stages["never"]?.status).toBe("pending");
  });

  it("rejects invalid code YAML before spawning its command", () => {
    const root = makeProject();
    const marker = spawnMarkerPath(root, "invalid-code");
    writePipeline(
      root,
      "invalid-code",
      `
id: invalid-code
stages:
  - id: check
    kind: code
    command: node
    args: ["-e", "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')"]
    env:
      FORBIDDEN: value
`,
    );

    const outcome = runCli(root, "invalid-code", "B9-INVALID-CODE");

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "needs-attention" });
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects an unregistered gate at compile time without spawning a child", () => {
    const root = makeProject();
    writePipeline(
      root,
      "broken",
      `
id: broken
stages:
  - id: dev
    kind: agent
    workflow: dev-story
    agent: dev
    gate: no-such-gate
    timeout: 60
`,
    );

    const outcome = runCli(root, "broken", "B7-FOREIGN");

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "needs-attention" });
    expect(existsSync(spawnMarkerPath(root, "b7"))).toBe(false);
  });
});
