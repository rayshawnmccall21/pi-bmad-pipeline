import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RunDefLoadError,
  discoverRunDefs,
  getRunDefPipelinesDir,
  isRunDefYamlFileName,
  loadRunDefFile,
  resolveDiscoveredRunDef,
} from "./index.js";

let projectRoot: string | undefined;

const createProjectRoot = async (): Promise<string> => {
  projectRoot = await mkdtemp(join(tmpdir(), "pi-bmad-pipeline-rundef-"));
  return projectRoot;
};

const writePipeline = async (root: string, fileName: string, content: string): Promise<string> => {
  const directory = getRunDefPipelinesDir(root);
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, fileName);
  await writeFile(filePath, content, "utf8");
  return filePath;
};

const validRunDefYaml = (id: string): string =>
  `id: ${id}\nstages:\n  - id: create-story\n    kind: agent\n    workflow: create-story\n    agent: sm\n`;

afterEach(async () => {
  if (projectRoot !== undefined) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

describe("RunDef loader", () => {
  it("resolves the project pipelines directory", async () => {
    const root = await createProjectRoot();
    expect(getRunDefPipelinesDir(root)).toBe(join(root, ".pi", "bmad", "pipelines"));
  });

  it.each(["", " ", "\t"])("rejects blank project root %j", (value) => {
    expect(() => getRunDefPipelinesDir(value)).toThrow(RangeError);
  });

  it("identifies discoverable YAML file names", () => {
    expect(isRunDefYamlFileName("custom.yaml")).toBe(true);
    expect(isRunDefYamlFileName("custom.yml")).toBe(false);
    expect(isRunDefYamlFileName(".hidden.yaml")).toBe(false);
    expect(isRunDefYamlFileName("custom.YAML")).toBe(false);
    expect(isRunDefYamlFileName("custom.yaml.bak")).toBe(false);
  });

  it("returns an empty catalog when the pipelines directory is missing", async () => {
    const root = await createProjectRoot();
    await expect(discoverRunDefs(root)).resolves.toEqual([]);
  });

  it("loads and validates one RunDef YAML file", async () => {
    const root = await createProjectRoot();
    const filePath = await writePipeline(root, "custom.yaml", validRunDefYaml("custom"));
    const discovered = await loadRunDefFile(filePath);
    expect(discovered).toEqual({
      id: "custom",
      path: filePath,
      runDef: {
        id: "custom",
        stages: [{ id: "create-story", kind: "agent", workflow: "create-story", agent: "sm" }],
      },
    });
  });

  it.each(["", " ", "\t"])("rejects blank file path %j", async (value) => {
    await expect(loadRunDefFile(value)).rejects.toThrow(RangeError);
  });

  it("discovers YAML files in deterministic path order", async () => {
    const root = await createProjectRoot();
    await writePipeline(root, "zeta.yaml", validRunDefYaml("zeta"));
    await writePipeline(root, "alpha.yaml", validRunDefYaml("alpha"));
    const discovered = await discoverRunDefs(root);
    expect(discovered.map((d) => d.id)).toEqual(["alpha", "zeta"]);
  });

  it("ignores non-discoverable entries", async () => {
    const root = await createProjectRoot();
    const directory = getRunDefPipelinesDir(root);
    await writePipeline(root, "custom.yaml", validRunDefYaml("custom"));
    await writePipeline(root, "ignored.yml", validRunDefYaml("ignored-yml"));
    await writePipeline(root, ".hidden.yaml", validRunDefYaml("hidden"));
    await mkdir(join(directory, "nested.yaml"), { recursive: true });
    const discovered = await discoverRunDefs(root);
    expect(discovered.map((d) => d.id)).toEqual(["custom"]);
  });

  it("resolves a discovered RunDef by id", async () => {
    const root = await createProjectRoot();
    await writePipeline(root, "not-the-id.yaml", validRunDefYaml("custom"));
    const discovered = await resolveDiscoveredRunDef(root, "custom");
    expect(discovered?.id).toBe("custom");
    expect(discovered?.runDef.id).toBe("custom");
  });

  it("returns undefined when a discovered RunDef id is absent", async () => {
    const root = await createProjectRoot();
    await writePipeline(root, "custom.yaml", validRunDefYaml("custom"));
    await expect(resolveDiscoveredRunDef(root, "missing")).resolves.toBeUndefined();
  });

  it("throws RunDefLoadError when YAML cannot be parsed", async () => {
    const root = await createProjectRoot();
    const filePath = await writePipeline(root, "broken.yaml", "id: [unclosed");
    await expect(loadRunDefFile(filePath)).rejects.toThrow(RunDefLoadError);
    try {
      await loadRunDefFile(filePath);
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RunDefLoadError);
      if (error instanceof RunDefLoadError) {
        expect(error.code).toBe("yaml-parse-failed");
        expect(error.path).toBe(filePath);
        expect(error.message).toMatch(/Failed to parse RunDef YAML file/u);
      }
    }
  });

  it("throws RunDefLoadError when YAML does not satisfy the RunDef schema", async () => {
    const root = await createProjectRoot();
    const filePath = await writePipeline(root, "invalid.yaml", "id: invalid\nstages: []\n");
    try {
      await loadRunDefFile(filePath);
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RunDefLoadError);
      if (error instanceof RunDefLoadError) {
        expect(error.code).toBe("invalid-rundef");
        expect(error.path).toBe(filePath);
        expect(error.message).toMatch(/Invalid RunDef file/u);
      }
    }
  });

  it("throws RunDefLoadError when the pipelines path is not a directory", async () => {
    const root = await createProjectRoot();
    const pipelinesPath = getRunDefPipelinesDir(root);
    await mkdir(join(root, ".pi", "bmad"), { recursive: true });
    await writeFile(pipelinesPath, "not a directory", "utf8");
    try {
      await discoverRunDefs(root);
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RunDefLoadError);
      if (error instanceof RunDefLoadError) {
        expect(error.code).toBe("read-failed");
        expect(error.path).toBe(pipelinesPath);
      }
    }
  });

  it("throws RunDefLoadError for duplicate discovered RunDef ids", async () => {
    const root = await createProjectRoot();
    const firstPath = await writePipeline(root, "first.yaml", validRunDefYaml("duplicate"));
    const secondPath = await writePipeline(root, "second.yaml", validRunDefYaml("duplicate"));
    try {
      await discoverRunDefs(root);
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RunDefLoadError);
      if (error instanceof RunDefLoadError) {
        expect(error.code).toBe("duplicate-rundef-id");
        expect(error.runDefId).toBe("duplicate");
        expect(error.duplicatePath).toBe(firstPath);
        expect(error.path).toBe(secondPath);
      }
    }
  });
});
