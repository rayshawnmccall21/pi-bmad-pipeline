import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RunDefCompileError,
  RunDefSelectionError,
  SDLC_RUNDEF,
  clearPayloadGateRegistry,
  getRunDefPipelinesDir,
  registerPayloadGate,
  resolveRunDefSelection,
  selectAndCompileRunDef,
  selectRunDef,
} from "./index.js";

import type { DiscoveredRunDef, PayloadGate, PayloadGateRegistry, RunDef } from "./index.js";

let projectRoot: string | undefined;

const passGate: PayloadGate = () => ({ passed: true });

/**
 * Creates a fresh temporary project root.
 *
 * @returns The temp directory path.
 */
async function createProjectRoot(): Promise<string> {
  projectRoot = await mkdtemp(join(tmpdir(), "pi-bmad-pipeline-selector-"));
  return projectRoot;
}

/**
 * Writes a pipeline YAML file inside a project root.
 *
 * @param root - Project root directory.
 * @param fileName - YAML file name.
 * @param content - YAML content.
 *
 * @returns The absolute file path.
 */
async function writePipeline(root: string, fileName: string, content: string): Promise<string> {
  const directory = getRunDefPipelinesDir(root);
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, fileName);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

/**
 * Builds a minimal valid RunDef object.
 *
 * @param id - RunDef id.
 *
 * @returns A minimal RunDef.
 */
function minimalRunDef(id: string): RunDef {
  return {
    id,
    stages: [{ id: "create-story", kind: "agent", workflow: "create-story", agent: "sm" }],
  };
}

/**
 * Builds a discovered RunDef entry with a synthetic path.
 *
 * @param id - RunDef id.
 *
 * @returns A DiscoveredRunDef.
 */
function discoveredRunDef(id: string): DiscoveredRunDef {
  return {
    id,
    path: `/tmp/${id}.yaml`,
    runDef: minimalRunDef(id),
  };
}

/**
 * Builds a minimal valid RunDef YAML string.
 *
 * @param id - RunDef id.
 *
 * @returns YAML content string.
 */
function validRunDefYaml(id: string): string {
  return `
id: ${id}
stages:
  - id: create-story
    kind: agent
    workflow: create-story
    agent: sm
`;
}

beforeEach(() => {
  clearPayloadGateRegistry();
});

afterEach(async () => {
  if (projectRoot !== undefined) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

describe("RunDef selector", () => {
  it("resolves the built-in SDLC RunDef from an empty discovered catalog", () => {
    const selection = resolveRunDefSelection("sdlc", []);

    expect(selection).toEqual({
      id: "sdlc",
      source: "builtin",
      runDef: SDLC_RUNDEF,
    });
    expect(Object.isFrozen(selection)).toBe(true);
  });

  it("resolves a discovered RunDef from a preloaded catalog", () => {
    const discovered = discoveredRunDef("custom");

    const selection = resolveRunDefSelection("custom", [discovered]);

    expect(selection).toEqual({
      id: "custom",
      source: "discovered",
      path: discovered.path,
      runDef: discovered.runDef,
    });
    expect(Object.isFrozen(selection)).toBe(true);
  });

  it("returns undefined when no RunDef matches", () => {
    expect(resolveRunDefSelection("missing", [])).toBeUndefined();
  });

  it.each(["", " ", "SDLC", "sdlc_extra", "sdlc extra"])("rejects invalid RunDef id %j", (id) => {
    expect(() => resolveRunDefSelection(id, [])).toThrow(RangeError);
  });

  it("fails closed when a discovered RunDef conflicts with a built-in id", () => {
    const discovered = discoveredRunDef("sdlc");

    expect(() => resolveRunDefSelection("sdlc", [discovered])).toThrow(RunDefSelectionError);

    try {
      resolveRunDefSelection("sdlc", [discovered]);
      expect.unreachable("resolveRunDefSelection should throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(RunDefSelectionError);

      if (error instanceof RunDefSelectionError) {
        expect(error.code).toBe("builtin-discovered-conflict");
        expect(error.id).toBe("sdlc");
        expect(error.path).toBe(discovered.path);
        expect(error.message).toBe(
          `RunDef "sdlc" is defined both as a built-in RunDef and by discovered file "${discovered.path}".`,
        );
      }
    }
  });

  it("selects a built-in RunDef from a project with no discovered pipelines", async () => {
    const root = await createProjectRoot();

    const selection = await selectRunDef(root, "sdlc");

    expect(selection).toEqual({
      id: "sdlc",
      source: "builtin",
      runDef: SDLC_RUNDEF,
    });
  });

  it("discovers and selects a project RunDef by id", async () => {
    const root = await createProjectRoot();
    const filePath = await writePipeline(root, "custom.yaml", validRunDefYaml("custom"));

    const selection = await selectRunDef(root, "custom");

    expect(selection).toEqual({
      id: "custom",
      source: "discovered",
      path: filePath,
      runDef: minimalRunDef("custom"),
    });
  });

  it("uses an injected discovered catalog instead of requiring files on disk", async () => {
    const root = await createProjectRoot();
    const discovered = discoveredRunDef("custom");

    const selection = await selectRunDef(root, "custom", {
      discoveredRunDefs: [discovered],
    });

    expect(selection).toEqual({
      id: "custom",
      source: "discovered",
      path: discovered.path,
      runDef: discovered.runDef,
    });
  });

  it("throws RunDefSelectionError when selection misses", async () => {
    const root = await createProjectRoot();

    try {
      await selectRunDef(root, "missing");
      expect.unreachable("selectRunDef should throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(RunDefSelectionError);

      if (error instanceof RunDefSelectionError) {
        expect(error.code).toBe("rundef-not-found");
        expect(error.id).toBe("missing");
        expect(error.projectRoot).toBe(root);
        expect(error.message).toBe(
          `RunDef "missing" was not found in built-ins or discovered project RunDefs for "${root}".`,
        );
      }
    }
  });

  it.each(["", " ", "\t"])("rejects blank project root %j", async (root) => {
    await expect(selectRunDef(root, "sdlc")).rejects.toThrow(RangeError);
  });

  it("propagates discovered YAML conflicts with built-ins", async () => {
    const root = await createProjectRoot();
    const filePath = await writePipeline(root, "override.yaml", validRunDefYaml("sdlc"));

    try {
      await selectRunDef(root, "sdlc");
      expect.unreachable("selectRunDef should throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(RunDefSelectionError);

      if (error instanceof RunDefSelectionError) {
        expect(error.code).toBe("builtin-discovered-conflict");
        expect(error.path).toBe(filePath);
      }
    }
  });

  it("compiles a discovered RunDef selection", async () => {
    const root = await createProjectRoot();

    await writePipeline(root, "custom.yaml", validRunDefYaml("custom"));

    const selection = await selectAndCompileRunDef(root, "custom", {
      defaultTimeoutSeconds: 42,
    });

    expect(selection.source).toBe("discovered");
    expect(selection.id).toBe("custom");
    expect(selection.stages).toEqual([
      {
        id: "create-story",
        kind: "agent",
        workflow: "create-story",
        agent: "sm",
        index: 0,
        timeoutSeconds: 42,
      },
    ]);
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.stages)).toBe(true);
  });

  it("passes an injected payload gate registry through to compilation", async () => {
    const root = await createProjectRoot();
    const registry: PayloadGateRegistry = {
      resolve(name) {
        return name === "custom-gate" ? passGate : undefined;
      },
    };

    await writePipeline(
      root,
      "custom.yaml",
      `
id: custom
stages:
  - id: dev-story
    kind: agent
    workflow: dev-story
    agent: dev
  - id: verify
    kind: agent
    workflow: verify
    agent: tea
    gate: custom-gate
    onFail: dev-story
`,
    );

    const selection = await selectAndCompileRunDef(root, "custom", { registry });

    expect(selection.stages[1]?.payloadGateName).toBe("custom-gate");
    expect(selection.stages[1]?.payloadGate).toBe(passGate);
  });

  it("compiles the built-in SDLC RunDef when required gates are registered", async () => {
    const root = await createProjectRoot();

    registerPayloadGate("e2e-verify", passGate);
    registerPayloadGate("code-review", passGate);

    const selection = await selectAndCompileRunDef(root, "sdlc");

    expect(selection.source).toBe("builtin");
    expect(selection.id).toBe("sdlc");
    expect(selection.stages.map((stage) => stage.id)).toEqual([
      "create-story",
      "e2e-plan",
      "dev-story",
      "e2e-verify",
      "code-review",
      "docs",
    ]);
  });

  it("does not require payload gates for selection, but compilation fails closed", async () => {
    const root = await createProjectRoot();

    await expect(selectRunDef(root, "sdlc")).resolves.toMatchObject({
      id: "sdlc",
      source: "builtin",
    });
    await expect(selectAndCompileRunDef(root, "sdlc")).rejects.toThrow(RunDefCompileError);
  });
});
