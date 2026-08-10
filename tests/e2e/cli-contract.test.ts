/**
 * Group E — CLI contract filters.
 *
 * Exit-code matrix, help/version surface, and the JSONL vs human event
 * rendering split.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  HAPPY_PIPELINE,
  makeProject,
  runCli,
  runRaw,
  singleResult,
  writePipeline,
} from "./harness.js";

describe("CLI contract", () => {
  it("maps passed runs to exit 0", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);

    const outcome = runCli(root, "happy", "E1-PASSED");

    expect(outcome.status).toBe(0);
    expect(singleResult(outcome)).toMatchObject({ status: "passed" });
  });

  it("maps failed runs to exit 2", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);

    const outcome = runCli(root, "happy", "E1-FAILED", { E2E_FORGE: "1" });

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed" });
  });

  it("maps needs-attention runs to exit 2", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);
    const lockDir = join(root, ".pi", "pipeline", "locks", "E1-ATTENTION");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "info.json"),
      JSON.stringify({ pid: process.pid, runId: "held", startedAt: new Date().toISOString() }),
      "utf8",
    );

    const outcome = runCli(root, "happy", "E1-ATTENTION");

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "needs-attention" });
  });

  it("maps parse errors, unknown commands, and invalid story ids to exit 1", () => {
    const missingArgs = runRaw(["run", "happy"]);
    expect(missingArgs.status).toBe(1);
    expect(missingArgs.stderr.length).toBeGreaterThan(0);

    const unknownCommand = runRaw(["audit"]);
    expect(unknownCommand.status).toBe(1);
    expect(unknownCommand.stderr).toContain("unknown-command");

    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);
    const invalidStory = runCli(root, "happy", "not a valid story id!");
    expect(invalidStory.status).toBe(1);
    expect(invalidStory.stderr.length).toBeGreaterThan(0);
  });

  it("prints help and version to stdout with exit 0", () => {
    const help = runRaw(["help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("run <rundef-id>");

    const version = runRaw(["version"]);
    expect(version.status).toBe(0);
    expect(version.stdout).toMatch(/^pi-bmad-pipeline v\d+\.\d+\.\d+/u);
  });

  it("emits raw JSONL with --jsonl and human lines without it", () => {
    const root = makeProject();
    writePipeline(root, "happy", HAPPY_PIPELINE);

    const raw = runCli(root, "happy", "E3-RAW");
    expect(raw.status).toBe(0);
    const lines = raw.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(JSON.parse(line) as unknown).toBeDefined();
    }

    const human = runCli(root, "happy", "E3-HUMAN", {}, [], false);
    expect(human.status).toBe(0);
    expect(human.stdout).not.toMatch(/^\s*\{"event"/u);
    expect(human.stdout).toContain("passed");
  });
});
