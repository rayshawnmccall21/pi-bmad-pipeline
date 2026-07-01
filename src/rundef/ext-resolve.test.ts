import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RUNDEF_STAGE_EXTENSIONS_RELATIVE_DIR,
  getStageExtensionsDir,
  resolveStageExtensionBaseDir,
  resolveStageExtensionPath,
  resolveStageExtensionPaths,
} from "./index.js";

import type { StageExtensionPathStage } from "./index.js";

const projectRoot = resolve("/tmp/pi-bmad-pipeline-project");

const stage = (id: string): StageExtensionPathStage => ({ id });

describe("stage extension path resolution", () => {
  it("exports the default relative stage extensions directory", () => {
    expect(RUNDEF_STAGE_EXTENSIONS_RELATIVE_DIR).toBe(".pi/bmad/extensions");
  });

  it("resolves the default stage extensions directory", () => {
    expect(getStageExtensionsDir(projectRoot)).toBe(join(projectRoot, ".pi", "bmad", "extensions"));
  });

  it("normalizes relative project roots", () => {
    const relativeRoot = "tmp/project";

    expect(getStageExtensionsDir(relativeRoot)).toBe(
      resolve(relativeRoot, ".pi", "bmad", "extensions"),
    );
  });

  it.each(["", "  ", "\t"])("rejects blank project root %j", (root) => {
    expect(() => getStageExtensionsDir(root)).toThrow(RangeError);
    expect(() => resolveStageExtensionBaseDir({ projectRoot: root })).toThrow(RangeError);
    expect(() =>
      resolveStageExtensionPath({ projectRoot: root, stage: stage("dev-story") }),
    ).toThrow(RangeError);
  });

  it("resolves the default base directory through the request API", () => {
    expect(resolveStageExtensionBaseDir({ projectRoot })).toBe(
      join(projectRoot, ".pi", "bmad", "extensions"),
    );
  });

  it("resolves a custom relative base directory under the project root", () => {
    expect(
      resolveStageExtensionBaseDir({
        projectRoot,
        stageExtensionsDir: ".pi/custom-stage-extensions",
      }),
    ).toBe(join(projectRoot, ".pi", "custom-stage-extensions"));
  });

  it("resolves a custom absolute base directory under the project root", () => {
    const baseDir = join(projectRoot, ".pi", "custom-stage-extensions");

    expect(
      resolveStageExtensionBaseDir({
        projectRoot,
        stageExtensionsDir: baseDir,
      }),
    ).toBe(baseDir);
  });

  it.each(["", "  ", "\t"])("rejects blank custom base directory %j", (stageExtensionsDir) => {
    expect(() =>
      resolveStageExtensionBaseDir({
        projectRoot,
        stageExtensionsDir,
      }),
    ).toThrow(RangeError);
  });

  it("rejects a relative custom base directory that escapes the project root", () => {
    expect(() =>
      resolveStageExtensionBaseDir({
        projectRoot,
        stageExtensionsDir: "../outside",
      }),
    ).toThrow(
      `Stage extensions directory "${resolve(projectRoot, "../outside")}" must be inside project root "${projectRoot}".`,
    );
  });

  it("rejects an absolute custom base directory outside the project root", () => {
    const outsidePath = resolve("/tmp/outside-stage-extensions");

    expect(() =>
      resolveStageExtensionBaseDir({
        projectRoot,
        stageExtensionsDir: outsidePath,
      }),
    ).toThrow(
      `Stage extensions directory "${outsidePath}" must be inside project root "${projectRoot}".`,
    );
  });

  it("resolves one stage extension path", () => {
    const resolved = resolveStageExtensionPath({
      projectRoot,
      stage: stage("dev-story"),
    });

    expect(resolved).toEqual({
      stageId: "dev-story",
      projectRoot,
      baseDir: join(projectRoot, ".pi", "bmad", "extensions"),
      path: join(projectRoot, ".pi", "bmad", "extensions", "dev-story"),
    });
  });

  it("resolves one stage extension path under a custom base directory", () => {
    const resolved = resolveStageExtensionPath({
      projectRoot,
      stage: stage("e2e-verify"),
      stageExtensionsDir: ".pi/custom-stage-extensions",
    });

    expect(resolved).toEqual({
      stageId: "e2e-verify",
      projectRoot,
      baseDir: join(projectRoot, ".pi", "custom-stage-extensions"),
      path: join(projectRoot, ".pi", "custom-stage-extensions", "e2e-verify"),
    });
  });

  it("freezes resolved stage extension metadata", () => {
    const resolved = resolveStageExtensionPath({
      projectRoot,
      stage: stage("code-review"),
    });

    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it.each(["", "  ", "Dev-Story", "dev_story", "dev story", "-dev-story"])(
    "rejects invalid stage id %j",
    (stageId) => {
      expect(() =>
        resolveStageExtensionPath({
          projectRoot,
          stage: stage(stageId),
        }),
      ).toThrow(RangeError);
    },
  );

  it("resolves multiple stage extension paths in input order", () => {
    const resolved = resolveStageExtensionPaths({
      projectRoot,
      stages: [stage("create-story"), stage("e2e-plan"), stage("dev-story")],
    });

    expect(resolved.map((item) => item.stageId)).toEqual(["create-story", "e2e-plan", "dev-story"]);
    expect(resolved.map((item) => item.path)).toEqual([
      join(projectRoot, ".pi", "bmad", "extensions", "create-story"),
      join(projectRoot, ".pi", "bmad", "extensions", "e2e-plan"),
      join(projectRoot, ".pi", "bmad", "extensions", "dev-story"),
    ]);
  });

  it("freezes the multi-stage result array and each resolved item", () => {
    const resolved = resolveStageExtensionPaths({
      projectRoot,
      stages: [stage("create-story"), stage("dev-story")],
    });

    expect(Object.isFrozen(resolved)).toBe(true);
    for (const item of resolved) {
      expect(Object.isFrozen(item)).toBe(true);
    }
  });

  it("returns an empty frozen array for no stages", () => {
    const resolved = resolveStageExtensionPaths({
      projectRoot,
      stages: [],
    });

    expect(resolved).toEqual([]);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it("does not mutate stage inputs", () => {
    const inputStage = stage("docs");
    const before = JSON.stringify(inputStage);

    resolveStageExtensionPath({
      projectRoot,
      stage: inputStage,
    });

    expect(JSON.stringify(inputStage)).toBe(before);
  });
});
