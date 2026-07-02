import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saveHarnessEvidence } from "../security/index.js";
import {
  CURRENT_RUN_POINTER_RELATIVE_PATH,
  CurrentRunStoreError,
  createInitialPipelineState,
  getCurrentRunPointerPath,
  loadCurrentRunPointer,
  saveCurrentRunPointer,
  savePipelineState,
} from "./index.js";

const storyId = "STORY-123";

let projectRoot = "";

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "current-run-store-"));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

const agentClaim = { testsPassed: true, typecheckPassed: true, lintPassed: true };

describe("current-run pointer store", () => {
  it("resolves the pointer path inside the pipeline state directory", () => {
    expect(getCurrentRunPointerPath(projectRoot)).toBe(
      resolve(projectRoot, ".pi", "pipeline", "state", "current-run.json"),
    );
  });

  it("keeps the relative pointer path aligned with the merge-gate checkpoint module", async () => {
    const gateSource = await readFile(
      resolve(import.meta.dirname, "../../.pi/workflows/checkpoints/merge-gate.mjs"),
      "utf8",
    );

    expect(gateSource).toContain(`"${CURRENT_RUN_POINTER_RELATIVE_PATH}"`);
    expect(getCurrentRunPointerPath(projectRoot)).toBe(
      resolve(projectRoot, CURRENT_RUN_POINTER_RELATIVE_PATH),
    );
  });

  it("round-trips a pointer with an agent claim", async () => {
    const path = await saveCurrentRunPointer(projectRoot, { storyId, agentClaim });

    expect(path).toBe(getCurrentRunPointerPath(projectRoot));
    await expect(loadCurrentRunPointer(projectRoot)).resolves.toEqual({ storyId, agentClaim });
  });

  it("round-trips a pointer without an agent claim", async () => {
    await saveCurrentRunPointer(projectRoot, { storyId });

    const pointer = await loadCurrentRunPointer(projectRoot);

    expect(pointer).toEqual({ storyId });
    expect(pointer).not.toHaveProperty("agentClaim");
  });

  it("overwrites a stale pointer on save", async () => {
    await saveCurrentRunPointer(projectRoot, { storyId: "OLD-1" });
    await saveCurrentRunPointer(projectRoot, { storyId });

    await expect(loadCurrentRunPointer(projectRoot)).resolves.toEqual({ storyId });
  });

  it("rejects unsafe story ids on save", async () => {
    await expect(saveCurrentRunPointer(projectRoot, { storyId: "../evil" })).rejects.toThrow(
      RangeError,
    );
  });

  it("returns undefined when no pointer exists", async () => {
    await expect(loadCurrentRunPointer(projectRoot)).resolves.toBeUndefined();
  });

  it("fails closed on unparseable pointer JSON", async () => {
    await saveCurrentRunPointer(projectRoot, { storyId });
    await writeFile(getCurrentRunPointerPath(projectRoot), "{nope", "utf8");

    await expect(loadCurrentRunPointer(projectRoot)).rejects.toBeInstanceOf(CurrentRunStoreError);
  });

  it("fails closed on a pointer with an unsafe story id", async () => {
    await saveCurrentRunPointer(projectRoot, { storyId });
    await writeFile(
      getCurrentRunPointerPath(projectRoot),
      JSON.stringify({ storyId: "../evil" }),
      "utf8",
    );

    await expect(loadCurrentRunPointer(projectRoot)).rejects.toBeInstanceOf(CurrentRunStoreError);
  });

  it("fails closed on a pointer with a malformed agent claim", async () => {
    await saveCurrentRunPointer(projectRoot, { storyId });
    await writeFile(
      getCurrentRunPointerPath(projectRoot),
      JSON.stringify({ storyId, agentClaim: { testsPassed: "yes" } }),
      "utf8",
    );

    await expect(loadCurrentRunPointer(projectRoot)).rejects.toBeInstanceOf(CurrentRunStoreError);
  });
});

interface GateResult {
  readonly pass: boolean;
  readonly reason: string;
}

interface GateRegistration {
  readonly name: string;
  readonly handler: () => Promise<GateResult>;
}

interface MergeGateModule {
  readonly register: (api: { readJson: (path: string) => unknown }) => readonly GateRegistration[];
}

const loadMergeGateHandler = async (root: string): Promise<GateRegistration["handler"]> => {
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dirname, "../../.pi/workflows/checkpoints/merge-gate.mjs"),
  ).href;
  const imported = (await import(moduleUrl)) as { default: MergeGateModule };
  const api = {
    readJson: (path: string): unknown => {
      try {
        return JSON.parse(readFileSync(join(root, path), "utf8"));
      } catch {
        return null;
      }
    },
  };
  const registration = imported.default
    .register(api)
    .find((candidate) => candidate.name === "pipeline--merge-gate-green");
  if (registration === undefined) {
    throw new TypeError("merge gate registration missing.");
  }
  return registration.handler;
};

describe("current-run pointer feeds the merge-gate checkpoint", () => {
  it("passes the gate using artifacts written by the pipeline producers", async () => {
    await saveCurrentRunPointer(projectRoot, { storyId, agentClaim });
    await savePipelineState(
      projectRoot,
      createInitialPipelineState({
        storyId,
        specFile: "./specs/story-123.md",
        worktreePath: join(projectRoot, ".worktrees", storyId),
        branch: `bmad/${storyId}`,
        stages: [],
        model: "gpt-5.5-pro",
        thinking: "medium",
      }),
    );
    await saveHarnessEvidence({
      projectRoot,
      storyId,
      report: {
        projectRoot,
        startedAt: "2026-07-02T00:00:00.000Z",
        finishedAt: "2026-07-02T00:01:00.000Z",
        passed: true,
        commands: (["test", "typecheck", "lint"] as const).map((name) => ({
          name,
          command: "npm",
          args: ["run", name],
          status: "passed" as const,
          exitCode: 0,
          durationMs: 10,
          stdout: "",
          stderr: "",
        })),
      },
    });

    const handler = await loadMergeGateHandler(projectRoot);

    await expect(handler()).resolves.toMatchObject({ pass: true });
  });
});
