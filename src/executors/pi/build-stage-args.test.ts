import { describe, expect, it } from "vitest";

import { PI_OFFLINE_ENV_VAR } from "./build-stage-args.js";
import {
  DEFAULT_PI_BIN,
  PI_BMAD_EMISSION_KEY_ENV_VAR,
  PI_BMAD_RUN_ID_ENV_VAR,
  buildStageArgs,
} from "./index.js";

import type { BuildStageArgsRequest, StageArgsStage } from "./index.js";

const stage = (overrides: Partial<StageArgsStage> = {}): StageArgsStage => ({
  id: "dev-story",
  workflow: "dev-story",
  ...overrides,
});

const request = (overrides: Partial<BuildStageArgsRequest> = {}): BuildStageArgsRequest => ({
  stage: stage(),
  storyId: "STORY-123",
  specFile: "./specs/story-123.md",
  projectRoot: "/repo",
  attempt: 1,
  model: "gpt-5.5-pro",
  thinking: "medium",
  piBmadExtensionPath: "/deps/pi-bmad/extensions/pi-bmad.ts",
  emissionKey: "emission-key-1",
  ...overrides,
});

const argAfter = (args: readonly string[], name: string): string | undefined =>
  args[args.indexOf(name) + 1];

describe("Pi stage argv builder", () => {
  it("uses the default pi binary", () => {
    expect(buildStageArgs(request()).bin).toBe(DEFAULT_PI_BIN);
  });

  it("emits the real headless prefix: JSON mode, print, isolation", () => {
    expect(buildStageArgs(request()).args.slice(0, 5)).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
    ]);
  });

  it("loads the pi-bmad extension explicitly", () => {
    const args = buildStageArgs(request()).args;

    expect(argAfter(args, "-e")).toBe("/deps/pi-bmad/extensions/pi-bmad.ts");
  });

  it("emits the pi-bmad workflow and story flags", () => {
    const args = buildStageArgs(request()).args;

    expect(argAfter(args, "--bmad-workflow")).toBe("dev-story");
    expect(argAfter(args, "--bmad-story")).toBe("STORY-123");
  });

  it("emits real pi model and thinking flags", () => {
    const args = buildStageArgs(request()).args;

    expect(argAfter(args, "--model")).toBe("gpt-5.5-pro");
    expect(argAfter(args, "--thinking")).toBe("medium");
  });

  it("does not emit flags that do not exist in pi or pi-bmad", () => {
    const args = buildStageArgs(request({ priorFindings: ["a"] })).args;
    const removedFlags = [
      "--jsonl",
      "bmad:run-workflow",
      "--workflow",
      "--agent",
      "--stage-id",
      "--story-id",
      "--spec-file",
      "--project-root",
      "--worktree-cwd",
      "--attempt",
      "--timeout-seconds",
      "--stage-extension",
      "--prior-findings-json",
    ];

    for (const flag of removedFlags) {
      expect(args).not.toContain(flag);
    }
  });

  it("ends with a prompt naming the workflow, story, spec file, stage, and attempt", () => {
    const args = buildStageArgs(request()).args;
    const prompt = args.at(-1);

    expect(prompt).toContain("dev-story");
    expect(prompt).toContain("STORY-123");
    expect(prompt).toContain("./specs/story-123.md");
    expect(prompt).toContain("attempt 1");
  });

  it("omits the Spec file line from the prompt when specFile is blank", () => {
    const prompt = buildStageArgs(request({ specFile: "" })).args.at(-1);

    expect(prompt).toContain("dev-story");
    expect(prompt).toContain("STORY-123");
    expect(prompt).toContain("attempt 1");
    expect(prompt).not.toContain("Spec file:");
  });

  it("folds prior findings into the prompt only when provided", () => {
    expect(buildStageArgs(request()).args.at(-1)).not.toContain("Prior findings");

    const prompt = buildStageArgs(request({ priorFindings: ["finding-b", "finding-a"] })).args.at(
      -1,
    );

    expect(prompt).toContain("Prior findings to address:");
    expect(prompt).toContain("- finding-b");
    expect(prompt).toContain("- finding-a");
  });

  it("emits only the pi-bmad extension when no stage extensions are provided", () => {
    const countExtensionFlags = (args: readonly string[]): number =>
      args.filter((arg) => arg === "-e").length;

    expect(countExtensionFlags(buildStageArgs(request()).args)).toBe(1);
  });

  it("appends each stage extension as an additional -e after the pi-bmad extension", () => {
    const args = buildStageArgs(
      request({ stage: stage({ extensions: ["/ext/obs.ts", "/ext/subagents.ts"] }) }),
    ).args;

    const flags = args.filter((arg) => arg === "-e");
    expect(flags).toHaveLength(3);
    expect(args[args.indexOf("-e") + 1]).toBe("/deps/pi-bmad/extensions/pi-bmad.ts");
    const afterFirst = args.slice(args.indexOf("-e") + 2);
    expect(afterFirst[afterFirst.indexOf("-e") + 1]).toBe("/ext/obs.ts");
    const afterSecond = afterFirst.slice(afterFirst.indexOf("-e") + 2);
    expect(afterSecond[afterSecond.indexOf("-e") + 1]).toBe("/ext/subagents.ts");
  });

  it("emits no extra -e flags when extensions is an empty array", () => {
    const countExtensionFlags = (args: readonly string[]): number =>
      args.filter((arg) => arg === "-e").length;

    expect(countExtensionFlags(buildStageArgs(request({ stage: stage({ extensions: [] }) })).args)).toBe(1);
  });

  it("emits --o-pool, --o-name, --o-tag when stage declares them", () => {
    const args = buildStageArgs(
      request({ stage: stage({ oPool: "STY-91", oName: "dev-story", oTag: "dev-story" }) }),
    ).args;

    expect(argAfter(args, "--o-pool")).toBe("STY-91");
    expect(argAfter(args, "--o-name")).toBe("dev-story");
    expect(argAfter(args, "--o-tag")).toBe("dev-story");
  });

  it("omits observability flags when stage does not declare them", () => {
    const args = buildStageArgs(request()).args;

    expect(args).not.toContain("--o-pool");
    expect(args).not.toContain("--o-name");
    expect(args).not.toContain("--o-tag");
  });

  it("emits the run id and emission key env contract", () => {
    const invocation = buildStageArgs(request());

    expect(invocation.env[PI_BMAD_RUN_ID_ENV_VAR]).toBe("STORY-123.dev-story.1");
    expect(invocation.env[PI_BMAD_EMISSION_KEY_ENV_VAR]).toBe("emission-key-1");
  });

  it("honors an explicit run id", () => {
    const invocation = buildStageArgs(request({ runId: "run-77" }));

    expect(invocation.env[PI_BMAD_RUN_ID_ENV_VAR]).toBe("run-77");
  });

  it("emits PI_OFFLINE=1 so the child skips startup network operations", () => {
    expect(buildStageArgs(request()).env[PI_OFFLINE_ENV_VAR]).toBe("1");
  });

  it("emits exactly the documented hermetic child env contract", () => {
    expect(buildStageArgs(request()).env).toEqual({
      PI_BMAD_RUN_ID: "STORY-123.dev-story.1",
      PI_BMAD_EMISSION_KEY: "emission-key-1",
      PI_OFFLINE: "1",
    });
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

  it("freezes return object, args, and env", () => {
    const invocation = buildStageArgs(request());

    expect(Object.isFrozen(invocation)).toBe(true);
    expect(Object.isFrozen(invocation.args)).toBe(true);
    expect(Object.isFrozen(invocation.env)).toBe(true);
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
    ["storyId", { storyId: " " }],
    ["projectRoot", { projectRoot: " " }],
    ["projectRoot", { projectRoot: " " }],
    ["model", { model: " " }],
    ["piBmadExtensionPath", { piBmadExtensionPath: " " }],
    ["emissionKey", { emissionKey: " " }],
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

  it.each([
    ["piBin", { piBin: " " }],
    ["runId", { runId: " " }],
  ] satisfies readonly [string, Partial<BuildStageArgsRequest>][])(
    "rejects blank optional string %s",
    (field, overrides) => {
      expect(() => buildStageArgs(request(overrides))).toThrow(`${field} must not be blank.`);
    },
  );
});
