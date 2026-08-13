import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { CLI_USAGE_LINES, parseCliArgs } from "./cli-args.js";
import { buildStageArgs } from "./executors/pi/build-stage-args.js";
import { registerBmadPayloadGates } from "./gates/bmad-gates.js";
import { clearPayloadGateRegistry } from "./rundef/registry.js";
import type { RunDefSelectionError } from "./rundef/selector.js";
import { selectAndCompileRunDef, selectRunDef } from "./rundef/selector.js";

const projectRoot = resolve(import.meta.dirname, "..");
const sourceRoot = join(projectRoot, "src");

const removedSourcePaths = [
  "rundef/builtin.ts",
  "rundef/ext-resolve.ts",
  "contracts",
  "audit",
  "git/story-pull-request.ts",
  "git/secret-scan.ts",
  "security/harness-evidence.ts",
  "security/harness-evidence-command.ts",
  "security/harness-evidence-store.ts",
  "state/current-run-store.ts",
];

const readSource = (relativePath: string): string =>
  readFileSync(join(sourceRoot, relativePath), "utf8");

describe("YAML-only pipeline surface", () => {
  it("discovers and compiles the exact six-stage SDLC YAML definition", async () => {
    clearPayloadGateRegistry();
    registerBmadPayloadGates();

    const selection = await selectAndCompileRunDef(projectRoot, "sdlc");

    expect(selection.source).toBe("discovered");
    expect(selection.stages.map(({ id }) => id)).toEqual([
      "create-story",
      "e2e-plan",
      "dev-story",
      "e2e-verify",
      "code-review",
      "docs",
    ]);
    expect(selection.stages.map(({ timeoutSeconds }) => timeoutSeconds)).toEqual([
      1800, 1800, 3600, 7200, 1800, 1800,
    ]);
    expect(selection.stages[3]).toMatchObject({
      payloadGateName: "e2e-verify",
      onFail: "dev-story",
    });
    expect(selection.stages[4]).toMatchObject({
      payloadGateName: "code-review",
      onFail: "dev-story",
      thinking: "high",
    });
    expect(selection.stages[5]).toMatchObject({ thinking: "high" });
  });

  it("fails closed when no discovered YAML matches instead of using compiled-in policy", async () => {
    const emptyProject = await mkdtemp(join(tmpdir(), "yaml-only-rundef-"));

    await expect(selectRunDef(emptyProject, "sdlc")).rejects.toMatchObject({
      code: "rundef-not-found",
    } satisfies Partial<RunDefSelectionError>);
  });

  it("removes every competing policy module and forbidden production seam", () => {
    for (const removedPath of removedSourcePaths) {
      expect(existsSync(join(sourceRoot, removedPath)), removedPath).toBe(false);
    }

    const forbiddenSymbols = [
      ["SDLC", "RUNDEF"].join("_"),
      ["resolve", "Builtin", "RunDef"].join(""),
      ["BUILTIN", "RUNDEF"].join("_"),
      ["openStory", "PullRequest"].join(""),
      ["evaluate", "MergeGate"].join(""),
      ["scanGitDiff", "ForSecrets"].join(""),
      ["runHarness", "Evidence"].join(""),
      ["saveHarness", "Evidence"].join(""),
      ["generatePipeline", "AuditReport"].join(""),
      ["saveCurrentRun", "Pointer"].join(""),
      ["stageExtension", "Path"].join(""),
    ];
    const productionFiles = [
      "rundef/selector.ts",
      "actions/run-pipeline-action.ts",
      "actions/run-pipeline-execution.ts",
      "actions/run-pipeline-settlement.ts",
      "cli.ts",
      "events/pipeline-event.ts",
      "executors/pi/build-stage-args.ts",
      "executors/pi/pi-cli-executor.ts",
      "executors/pi/run-bmad-stage.ts",
      "index.ts",
    ];
    const productionSurface = productionFiles.map(readSource).join("\n");
    for (const forbiddenSymbol of forbiddenSymbols) {
      expect(productionSurface, forbiddenSymbol).not.toContain(forbiddenSymbol);
    }
  });

  it("exposes only run, help, and version in the CLI grammar", () => {
    for (const removedCommand of ["audit", "iso", "merge"]) {
      expect(parseCliArgs([removedCommand])).toMatchObject({
        kind: "parse-error",
        code: "unknown-command",
      });
    }
    expect(
      parseCliArgs(["run", "sdlc", "--story-id", "strip-1", "--spec-file", "spec.md", "--no-pr"]),
    ).toMatchObject({ kind: "parse-error", code: "unknown-option" });
    expect(parseCliArgs(["run", "--story-id", "strip-1", "--spec-file", "spec.md"])).toMatchObject({
      kind: "parse-error",
      code: "missing-positional",
    });
    expect(CLI_USAGE_LINES.join("\n")).toBe(
      [
        "Usage: bmad-pipeline [command] [options]",
        "Commands:",
        "  run <rundef-id> [--story-id ID] [--spec-file PATH] [--project-root DIR]",
        "      [--model NAME] [--thinking EFFORT] [--max-regressions N] [--jsonl]",
        "  help | version",
      ].join("\n"),
    );
  });

  it("keeps exactly one explicit pi-bmad extension and no extension override seam", () => {
    const request = {
      stage: { id: "dev-story", workflow: "dev-story" },
      storyId: "strip-1",
      specFile: "spec.md",
      projectRoot,
      attempt: 1,
      model: "test-model",
      thinking: "medium" as const,
      piBmadExtensionPath: "/deps/pi-bmad/extensions/pi-bmad.ts",
      emissionKey: "key",
    };

    const invocation = buildStageArgs(request);

    expect(invocation.args.filter((argument) => argument === "-e")).toHaveLength(1);
    expect(readSource("executors/pi/build-stage-args.ts")).not.toContain(
      ["stageExtension", "Path"].join(""),
    );
  });

  it("removes policy events and hidden action settlement effects", () => {
    const eventSource = readSource("events/pipeline-event.ts");
    const settlementSource = readSource("actions/run-pipeline-settlement.ts");

    for (const removedEvent of ["evidence.finished", "pr.opened", "merge.decision"]) {
      expect(eventSource).not.toContain(removedEvent);
    }
    for (const removedEffect of [
      "runEvidence",
      "saveEvidence",
      "openPullRequest",
      "generateAuditReport",
    ]) {
      expect(settlementSource).not.toContain(removedEffect);
    }
    expect(settlementSource).toContain('emit("result"');
  });

  it("describes only the narrowed mechanism and ignores durable runtime state", () => {
    const packageManifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
      description: string;
    };
    const gitignore = readFileSync(join(projectRoot, ".gitignore"), "utf8").split("\n");

    expect(packageManifest.description).toContain("YAML");
    expect(packageManifest.description).toContain("durable state");
    expect(packageManifest.description).toContain("JSONL");
    expect(packageManifest.description).not.toMatch(/pull request|merge logic|audit/iu);
    expect(gitignore.filter((line) => line === ".pi/pipeline/")).toHaveLength(1);
  });
});
