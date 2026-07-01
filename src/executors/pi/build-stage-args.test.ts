import { describe, expect, it } from "vitest";

import { DEFAULT_BMAD_HEADLESS_COMMAND, DEFAULT_PI_BIN, buildStageArgs } from "./index.js";

import type { BuildStageArgsRequest, StageArgsStage } from "./index.js";

const stage = (overrides: Partial<StageArgsStage> = {}): StageArgsStage => ({
  id: "dev-story",
  workflow: "dev-story",
  agent: "dev",
  timeoutSeconds: 1800,
  ...overrides,
});

const request = (overrides: Partial<BuildStageArgsRequest> = {}): BuildStageArgsRequest => ({
  stage: stage(),
  storyId: "STORY-123",
  specFile: "./specs/story-123.md",
  projectRoot: "/repo",
  worktreeCwd: "/repo/.worktrees/story-123",
  attempt: 1,
  model: "gpt-5.5-pro",
  thinking: "medium",
  ...overrides,
});

const argAfter = (args: readonly string[], name: string): string | undefined =>
  args[args.indexOf(name) + 1];

describe("Pi stage argv builder", () => {
  it("builds the default pi invocation", () => {
    const invocation = buildStageArgs(request());

    expect(invocation.bin).toBe(DEFAULT_PI_BIN);
    expect(invocation.args[3]).toBe(DEFAULT_BMAD_HEADLESS_COMMAND);
  });

  it("includes isolation and JSONL flags", () => {
    expect(buildStageArgs(request()).args.slice(0, 3)).toEqual([
      "--no-session",
      "--no-extensions",
      "--jsonl",
    ]);
  });

  it("places command before named workflow args", () => {
    const args = buildStageArgs(request()).args;

    expect(args.indexOf(DEFAULT_BMAD_HEADLESS_COMMAND)).toBeLessThan(args.indexOf("--workflow"));
  });

  it("includes required stage and run arguments", () => {
    const args = buildStageArgs(request()).args;

    expect(argAfter(args, "--workflow")).toBe("dev-story");
    expect(argAfter(args, "--agent")).toBe("dev");
    expect(argAfter(args, "--stage-id")).toBe("dev-story");
    expect(argAfter(args, "--story-id")).toBe("STORY-123");
    expect(argAfter(args, "--spec-file")).toBe("./specs/story-123.md");
    expect(argAfter(args, "--project-root")).toBe("/repo");
    expect(argAfter(args, "--worktree-cwd")).toBe("/repo/.worktrees/story-123");
    expect(argAfter(args, "--attempt")).toBe("1");
    expect(argAfter(args, "--model")).toBe("gpt-5.5-pro");
    expect(argAfter(args, "--thinking")).toBe("medium");
    expect(argAfter(args, "--timeout-seconds")).toBe("1800");
  });

  it("uses stage-level thinking override when present", () => {
    const invocation = buildStageArgs(request({ stage: stage({ thinking: "high" }) }));

    expect(invocation.thinking).toBe("high");
    expect(argAfter(invocation.args, "--thinking")).toBe("high");
  });

  it("uses request-level thinking when stage has none", () => {
    const invocation = buildStageArgs(request({ thinking: "low" }));

    expect(invocation.thinking).toBe("low");
    expect(argAfter(invocation.args, "--thinking")).toBe("low");
  });

  it("supports custom piBin", () => {
    expect(buildStageArgs(request({ piBin: "/usr/local/bin/pi" })).bin).toBe("/usr/local/bin/pi");
  });

  it("supports custom command", () => {
    expect(buildStageArgs(request({ command: "custom:run" })).args[3]).toBe("custom:run");
  });

  it("adds stage extension only when provided", () => {
    expect(buildStageArgs(request()).args).not.toContain("--stage-extension");
    expect(
      argAfter(
        buildStageArgs(request({ stageExtensionPath: "/tmp/ext" })).args,
        "--stage-extension",
      ),
    ).toBe("/tmp/ext");
  });

  it("adds prior findings JSON only when findings are provided", () => {
    expect(buildStageArgs(request()).args).not.toContain("--prior-findings-json");
    expect(
      argAfter(
        buildStageArgs(request({ priorFindings: ["b", "a"] })).args,
        "--prior-findings-json",
      ),
    ).toBe('["b","a"]');
  });

  it("freezes return object and args", () => {
    const invocation = buildStageArgs(request());

    expect(Object.isFrozen(invocation)).toBe(true);
    expect(Object.isFrozen(invocation.args)).toBe(true);
  });

  it("does not mutate request or findings", () => {
    const findings = ["a"];
    const input = request({ priorFindings: findings });
    const before = JSON.stringify({ input, findings });

    buildStageArgs(input);

    expect(JSON.stringify({ input, findings })).toBe(before);
  });

  it.each([
    ["stage.id", { stage: stage({ id: " " }) }],
    ["stage.workflow", { stage: stage({ workflow: " " }) }],
    ["stage.agent", { stage: stage({ agent: " " }) }],
    ["storyId", { storyId: " " }],
    ["specFile", { specFile: " " }],
    ["projectRoot", { projectRoot: " " }],
    ["worktreeCwd", { worktreeCwd: " " }],
    ["model", { model: " " }],
  ] satisfies readonly [string, Partial<BuildStageArgsRequest>][])(
    "rejects blank required string %s",
    (field, overrides) => {
      expect(() => buildStageArgs(request(overrides))).toThrow(`${field} must not be blank.`);
    },
  );

  it.each([0, 1.5, -1])("rejects invalid attempt %j", (attempt) => {
    expect(() => buildStageArgs(request({ attempt }))).toThrow(
      "attempt must be a positive integer.",
    );
  });

  it.each([0, 1.5, -1])("rejects invalid timeoutSeconds %j", (timeoutSeconds) => {
    expect(() => buildStageArgs(request({ stage: stage({ timeoutSeconds }) }))).toThrow(
      "stage.timeoutSeconds must be a positive integer.",
    );
  });

  it.each([
    ["piBin", { piBin: " " }],
    ["command", { command: " " }],
    ["stageExtensionPath", { stageExtensionPath: " " }],
  ] satisfies readonly [string, Partial<BuildStageArgsRequest>][])(
    "rejects blank optional string %s",
    (field, overrides) => {
      expect(() => buildStageArgs(request(overrides))).toThrow(`${field} must not be blank.`);
    },
  );
});
