import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEBUG_LOG_PREFIX, PIPELINE_DEBUG_ENV_VAR } from "../events/index.js";
import type { CompiledStageDef } from "../rundef/index.js";
import {
  PIPELINE_STATE_FILE_EXTENSION,
  PIPELINE_STATE_RELATIVE_DIR,
  PipelineStateStoreError,
  createInitialPipelineState,
  fsPipelineStateStore,
  getPipelineStateDir,
  getPipelineStatePath,
  isPipelineStateStoryId,
  loadPipelineState,
  savePipelineState,
} from "./index.js";

import type { PipelineState } from "./index.js";

let projectRoot: string | undefined;

const createProjectRoot = async (): Promise<string> => {
  projectRoot = await mkdtemp(join(tmpdir(), "pi-bmad-pipeline-state-"));
  return projectRoot;
};

const stage = (id: string, index: number): CompiledStageDef =>
  Object.freeze({
    id,
    kind: "agent",
    workflow: id,
    agent: "dev",
    index,
    timeoutSeconds: 1800,
  });

const createState = (storyId = "STORY-123"): PipelineState =>
  createInitialPipelineState({
    storyId,
    specFile: "./specs/story-123.md",
    worktreePath: "/tmp/worktree",
    branch: "bmad/story-123",
    stages: [stage("create-story", 0), stage("dev-story", 1)],
    model: "gpt-5.5-pro",
    thinking: "high",
    startedAt: "2026-07-01T00:00:00.000Z",
  });

afterEach(async () => {
  if (projectRoot !== undefined) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

describe("filesystem pipeline state store", () => {
  it("exports state path constants", () => {
    expect(PIPELINE_STATE_RELATIVE_DIR).toBe(".pi/pipeline/state");
    expect(PIPELINE_STATE_FILE_EXTENSION).toBe(".json");
  });

  it("resolves the pipeline state directory", async () => {
    const root = await createProjectRoot();
    expect(getPipelineStateDir(root)).toBe(join(root, ".pi", "pipeline", "state"));
  });

  it.each(["", " ", "\t"])("rejects blank project root %j", (root) => {
    expect(() => getPipelineStateDir(root)).toThrow(RangeError);
    expect(() => getPipelineStatePath(root, "STORY-123")).toThrow(RangeError);
  });

  it.each(["STORY-123", "story-123", "STORY_123", "STORY.123", "A1"])(
    "accepts filename-safe story id %j",
    (storyId) => {
      expect(isPipelineStateStoryId(storyId)).toBe(true);
    },
  );

  it.each([
    "",
    " ",
    ".",
    "..",
    "STORY 123",
    "STORY/123",
    "STORY\\123",
    "-STORY",
    "STORY-",
    "STORY:",
  ])("rejects unsafe story id %j", (storyId) => {
    expect(isPipelineStateStoryId(storyId)).toBe(false);
  });

  it("resolves the pipeline state file path", async () => {
    const root = await createProjectRoot();
    expect(getPipelineStatePath(root, "STORY-123")).toBe(
      join(root, ".pi", "pipeline", "state", "STORY-123.json"),
    );
  });

  it("rejects invalid story ids when resolving paths", async () => {
    const root = await createProjectRoot();
    expect(() => getPipelineStatePath(root, "STORY/123")).toThrow(RangeError);
  });

  it("returns undefined when the state file is missing", async () => {
    const root = await createProjectRoot();
    await expect(loadPipelineState(root, "STORY-123")).resolves.toBeUndefined();
  });

  it("saves state to the durable state file path", async () => {
    const root = await createProjectRoot();
    const state = createState();
    const statePath = await savePipelineState(root, state);
    const saved = await readFile(statePath, "utf8");
    expect(statePath).toBe(getPipelineStatePath(root, "STORY-123"));
    expect(saved).toBe(`${JSON.stringify(state, null, 2)}\n`);
  });

  it("creates the state directory when saving", async () => {
    const root = await createProjectRoot();
    await savePipelineState(root, createState());
    await expect(readFile(getPipelineStatePath(root, "STORY-123"), "utf8")).resolves.toContain(
      '"storyId": "STORY-123"',
    );
  });

  it("round-trips saved pipeline state", async () => {
    const root = await createProjectRoot();
    const state = createState();
    await savePipelineState(root, state);
    await expect(loadPipelineState(root, "STORY-123")).resolves.toEqual(state);
  });

  it("returns a deeply frozen loaded state snapshot", async () => {
    const root = await createProjectRoot();
    await savePipelineState(root, createState());
    const loaded = await loadPipelineState(root, "STORY-123");
    expect(loaded).toBeDefined();
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded?.stages)).toBe(true);
    expect(Object.isFrozen(loaded?.economics)).toBe(true);
    for (const stageState of Object.values(loaded?.stages ?? {})) {
      expect(Object.isFrozen(stageState)).toBe(true);
      expect(Object.isFrozen(stageState.history)).toBe(true);
    }
  });

  it("saves through the default store interface", async () => {
    const root = await createProjectRoot();
    const state = createState();
    const path = await fsPipelineStateStore.save({ projectRoot: root, state });
    expect(path).toBe(getPipelineStatePath(root, "STORY-123"));
  });

  it("loads through the default store interface", async () => {
    const root = await createProjectRoot();
    const state = createState();
    await savePipelineState(root, state);
    await expect(
      fsPipelineStateStore.load({ projectRoot: root, storyId: "STORY-123" }),
    ).resolves.toEqual(state);
  });

  it("throws json-parse-failed for invalid JSON", async () => {
    const root = await createProjectRoot();
    const path = getPipelineStatePath(root, "STORY-123");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ broken", "utf8");
    try {
      await loadPipelineState(root, "STORY-123");
      expect.unreachable("loadPipelineState should throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineStateStoreError);
      if (error instanceof PipelineStateStoreError) {
        expect(error.code).toBe("json-parse-failed");
        expect(error.path).toBe(path);
        expect(error.storyId).toBe("STORY-123");
        expect(error.message).toMatch(/Failed to parse pipeline state JSON file/u);
      }
    }
  });

  it("throws invalid-state for malformed state JSON", async () => {
    const root = await createProjectRoot();
    const path = getPipelineStatePath(root, "STORY-123");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ storyId: "STORY-123" }), "utf8");
    try {
      await loadPipelineState(root, "STORY-123");
      expect.unreachable("loadPipelineState should throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineStateStoreError);
      if (error instanceof PipelineStateStoreError) {
        expect(error.code).toBe("invalid-state");
        expect(error.path).toBe(path);
        expect(error.storyId).toBe("STORY-123");
        expect(error.message).toMatch(/Invalid pipeline state file/u);
      }
    }
  });

  it("throws invalid-state when the file story id does not match the requested story id", async () => {
    const root = await createProjectRoot();
    const otherState = createState("OTHER-123");
    const path = getPipelineStatePath(root, "STORY-123");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(otherState, null, 2)}\n`, "utf8");
    try {
      await loadPipelineState(root, "STORY-123");
      expect.unreachable("loadPipelineState should throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineStateStoreError);
      if (error instanceof PipelineStateStoreError) {
        expect(error.code).toBe("invalid-state");
        expect(error.reason).toBe(
          'State storyId "OTHER-123" does not match requested storyId "STORY-123".',
        );
      }
    }
  });

  it("throws read-failed when the state path is a directory", async () => {
    const root = await createProjectRoot();
    const path = getPipelineStatePath(root, "STORY-123");
    await mkdir(path, { recursive: true });
    try {
      await loadPipelineState(root, "STORY-123");
      expect.unreachable("loadPipelineState should throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineStateStoreError);
      if (error instanceof PipelineStateStoreError) {
        expect(error.code).toBe("read-failed");
        expect(error.path).toBe(path);
      }
    }
  });

  it("throws write-failed when the state directory path is blocked by a file", async () => {
    const root = await createProjectRoot();
    const stateDirectory = getPipelineStateDir(root);
    await mkdir(dirname(stateDirectory), { recursive: true });
    await writeFile(stateDirectory, "not a directory", "utf8");
    try {
      await savePipelineState(root, createState());
      expect.unreachable("savePipelineState should throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineStateStoreError);
      if (error instanceof PipelineStateStoreError) {
        expect(error.code).toBe("write-failed");
        expect(error.path).toBe(getPipelineStatePath(root, "STORY-123"));
      }
    }
  });

  it("rejects invalid state before writing", async () => {
    const root = await createProjectRoot();
    const state = {
      ...createState(),
      status: "not-a-status",
    } as unknown as PipelineState;
    await expect(savePipelineState(root, state)).rejects.toThrow(PipelineStateStoreError);
  });

  it("does not mutate state while saving", async () => {
    const root = await createProjectRoot();
    const state = createState();
    const before = JSON.stringify(state);
    await savePipelineState(root, state);
    expect(JSON.stringify(state)).toBe(before);
  });
});

const captureDebug = () => {
  vi.stubEnv(PIPELINE_DEBUG_ENV_VAR, "1");
  return vi.spyOn(process.stderr, "write").mockReturnValue(true);
};

const debugEvents = (write: ReturnType<typeof captureDebug>): Record<string, unknown>[] =>
  write.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith(`${DEBUG_LOG_PREFIX} `))
    .map((line) => JSON.parse(line.slice(DEBUG_LOG_PREFIX.length + 1)) as Record<string, unknown>);

describe("state store debug logging", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("emits state.save and state.load transition events with path and status", async () => {
    const root = await createProjectRoot();
    const state = createState();
    const write = captureDebug();

    const statePath = await savePipelineState(root, state);
    const loaded = await loadPipelineState(root, state.storyId);
    expect(loaded).toBeDefined();

    const events = debugEvents(write);
    expect(events.find((entry) => entry["event"] === "state.save")).toMatchObject({
      storyId: state.storyId,
      path: statePath,
      status: state.status,
      currentStage: state.currentStage,
      regressions: state.regressions,
    });
    expect(events.find((entry) => entry["event"] === "state.load")).toMatchObject({
      storyId: state.storyId,
      path: statePath,
      found: true,
      status: state.status,
    });
  });

  it("emits a state.load miss when no state file exists", async () => {
    const root = await createProjectRoot();
    const write = captureDebug();

    await expect(loadPipelineState(root, "STORY-404")).resolves.toBeUndefined();

    expect(debugEvents(write).find((entry) => entry["event"] === "state.load")).toMatchObject({
      storyId: "STORY-404",
      found: false,
    });
  });
});
