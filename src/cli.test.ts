import { describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";

import { defaultRunCliDeps, isMainModule, runCli, versionBanner } from "./cli.js";
import { runPipelineAction } from "./actions/index.js";
import type { PipelineEventSink } from "./events/index.js";
import type { RunResult } from "./state/index.js";

const sink = (): PipelineEventSink & { lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    write: (line): void => {
      lines.push(line);
    },
  };
};

const result = (status: RunResult["status"] = "passed"): RunResult =>
  Object.freeze({
    storyId: "S-1",
    specFile: "s.md",
    action: "run",
    status,
    stagesRun: Object.freeze(["dev"]),
    regressions: 0,
    durationMs: 1,
  });

describe("versionBanner", () => {
  it("includes package metadata", () => {
    expect(versionBanner()).toBe("pi-bmad-pipeline v0.1.0");
  });
});

describe("runCli", () => {
  it("writes parse errors and core-only usage to stderr", async () => {
    const stderr = sink();
    expect(await runCli(["audit"], { stderr })).toBe(1);
    expect(stderr.lines.join("\n")).toContain("unknown-command");
    expect(stderr.lines.join("\n")).toContain("run <rundef-id>");
  });

  it("writes help and version to stdout", async () => {
    const stdout = sink();
    expect(await runCli(["help"], { stdout })).toBe(0);
    expect(await runCli(["version"], { stdout })).toBe(0);
    expect(stdout.lines.at(-1)).toBe(versionBanner());
  });

  it("forwards the exact run mechanism request", async () => {
    const stdout = sink();
    const runPipeline = vi.fn(async (request: Parameters<typeof runPipelineAction>[0]) => {
      void request;
      return result();
    });
    const exitCode = await runCli(
      [
        "run",
        "custom",
        "--story-id",
        "S-1",
        "--spec-file",
        "s.md",
        "--model",
        "m",
        "--thinking",
        "high",
        "--max-regressions",
        "2",
        "--jsonl",
      ],
      { stdout, cwd: () => "/repo", env: { BMAD_PIPELINE_MODEL: "env" }, runPipeline },
    );
    expect(exitCode).toBe(0);
    expect(runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        rundefId: "custom",
        storyId: "S-1",
        specFile: "s.md",
        projectRoot: "/repo",
        model: "m",
        thinking: "high",
        maxRegressions: 2,
        env: { BMAD_PIPELINE_MODEL: "env" },
      }),
    );
    expect(runPipeline.mock.calls[0]?.[0]).not.toHaveProperty("openPr");
  });

  it("maps evaluated failure to exit 2 and formats human events", async () => {
    const stdout = sink();
    const runPipeline = vi.fn(async (request) => {
      request.sink?.write(JSON.stringify({ event: "progress", message: "working" }));
      return result("failed");
    });
    expect(
      await runCli(["run", "x", "--story-id", "S-1", "--spec-file", "s"], { stdout, runPipeline }),
    ).toBe(2);
    expect(stdout.lines).toEqual(["progress message=working"]);
  });

  it("redacts thrown credentials", async () => {
    const stderr = sink();
    const credential = `ghp_${"a".repeat(36)}`;
    const runPipeline = vi.fn(async (): Promise<RunResult> => {
      throw new Error(credential);
    });
    expect(
      await runCli(["run", "x", "--story-id", "S-1", "--spec-file", "s"], { stderr, runPipeline }),
    ).toBe(1);
    expect(stderr.lines.join("\n")).not.toContain(credential);
  });
});

describe("defaultRunCliDeps", () => {
  it("wires only the real run mechanism dependencies", () => {
    expect(defaultRunCliDeps.runPipeline).toBe(runPipelineAction);
    expect(Object.keys(defaultRunCliDeps).sort()).toEqual([
      "cwd",
      "env",
      "runPipeline",
      "stderr",
      "stdout",
    ]);
  });
});

describe("isMainModule", () => {
  it("matches resolved entry paths and rejects missing entries", () => {
    const moduleUrl = pathToFileURL("/real/cli.js").href;
    expect(isMainModule(moduleUrl, ["node", "/shim"], () => "/real/cli.js")).toBe(true);
    expect(isMainModule(moduleUrl, ["node"])).toBe(false);
  });
});
