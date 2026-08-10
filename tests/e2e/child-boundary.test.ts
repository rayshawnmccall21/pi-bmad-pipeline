/**
 * Group A — child-boundary fail-closed filters.
 *
 * Every envelope/jail path the supervisor must reject is triggered through the
 * built CLI, and each assertion pins the exact decision kind and failure
 * reason so a passing suite proves the fail-closed contract, not merely "no
 * crash".
 */
import { describe, expect, it } from "vitest";

import {
  HAPPY_PIPELINE,
  TIMEOUT_PIPELINE,
  makeProject,
  readState,
  runCli,
  singleResult,
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

  it("records a timed-out stage when the child exceeds the stage timeout", () => {
    const root = makeProject();
    writePipeline(root, "timeout", TIMEOUT_PIPELINE);

    const outcome = runCli(root, "timeout", "A12-TIMEOUT", { E2E_SLEEP_MS: "5000" });

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed" });
    expect(firstAttempt(root, "A12-TIMEOUT").status).toBe("timed-out");
  });
});
