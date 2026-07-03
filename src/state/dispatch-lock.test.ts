import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEBUG_LOG_PREFIX, PIPELINE_DEBUG_ENV_VAR } from "../events/index.js";
import {
  DEFAULT_DISPATCH_LOCK_STALE_MS,
  DISPATCH_LOCK_INFO_FILE_NAME,
  DISPATCH_LOCK_RELATIVE_DIR,
  acquireDispatchLock,
  getDispatchLockDir,
  getDispatchLocksDir,
  isDispatchLockStale,
  readDispatchLockInfo,
  releaseDispatchLock,
} from "./index.js";

import type { DispatchLockInfo } from "./index.js";

let projectRoot: string | undefined;

const createProjectRoot = async (): Promise<string> => {
  projectRoot = await mkdtemp(join(tmpdir(), "pi-bmad-pipeline-lock-"));
  return projectRoot;
};

const lockInfo = (overrides: Partial<DispatchLockInfo> = {}): DispatchLockInfo => ({
  pid: process.pid,
  runId: "run-1",
  startedAt: new Date().toISOString(),
  ...overrides,
});

const writeExistingLock = async (
  root: string,
  info: DispatchLockInfo | string,
): Promise<string> => {
  const lockDir = getDispatchLockDir(root, "STORY-123");
  await mkdir(lockDir, { recursive: true });
  const raw = typeof info === "string" ? info : JSON.stringify(info, null, 2);
  await writeFile(join(lockDir, DISPATCH_LOCK_INFO_FILE_NAME), raw, "utf8");
  return lockDir;
};

afterEach(async () => {
  if (projectRoot !== undefined) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

describe("dispatch lock", () => {
  it("exports dispatch lock constants", () => {
    expect(DISPATCH_LOCK_RELATIVE_DIR).toBe(".pi/pipeline/locks");
    expect(DISPATCH_LOCK_INFO_FILE_NAME).toBe("info.json");
    expect(DEFAULT_DISPATCH_LOCK_STALE_MS).toBeGreaterThan(0);
  });

  it("resolves lock directories", async () => {
    const root = await createProjectRoot();

    expect(getDispatchLocksDir(root)).toBe(join(root, ".pi", "pipeline", "locks"));
    expect(getDispatchLockDir(root, "STORY-123")).toBe(
      join(root, ".pi", "pipeline", "locks", "STORY-123"),
    );
  });

  it.each(["", " ", "\t"])("rejects blank project root %j", (root) => {
    expect(() => getDispatchLocksDir(root)).toThrow(RangeError);
    expect(() => getDispatchLockDir(root, "STORY-123")).toThrow(RangeError);
  });

  it.each(["", " ", ".", "..", "STORY/123", "STORY\\123", "-STORY", "STORY-"])(
    "rejects unsafe story id %j",
    async (storyId) => {
      const root = await createProjectRoot();

      expect(() => getDispatchLockDir(root, storyId)).toThrow(RangeError);
    },
  );

  it("acquires a lock and writes holder info", async () => {
    const root = await createProjectRoot();

    const lock = await acquireDispatchLock({
      projectRoot: root,
      storyId: "STORY-123",
      runId: "run-1",
    });

    expect(lock).toBeDefined();
    expect(Object.isFrozen(lock)).toBe(true);
    expect(Object.isFrozen(lock?.info)).toBe(true);
    expect(await readDispatchLockInfo(lock?.path ?? "")).toEqual(lock?.info);
  });

  it("creates the lock parent directory", async () => {
    const root = await createProjectRoot();

    const lock = await acquireDispatchLock({
      projectRoot: root,
      storyId: "STORY-123",
      runId: "run-1",
    });

    await expect(
      readFile(join(lock?.path ?? "", DISPATCH_LOCK_INFO_FILE_NAME), "utf8"),
    ).resolves.toContain('"runId": "run-1"');
  });

  it("returns undefined when a live dispatch holds the lock", async () => {
    const root = await createProjectRoot();
    const first = await acquireDispatchLock({
      projectRoot: root,
      storyId: "STORY-123",
      runId: "run-1",
    });

    await expect(
      acquireDispatchLock({ projectRoot: root, storyId: "STORY-123", runId: "run-2" }),
    ).resolves.toBeUndefined();

    await first?.release();
  });

  it("releases a lock best-effort", async () => {
    const root = await createProjectRoot();
    const lock = await acquireDispatchLock({
      projectRoot: root,
      storyId: "STORY-123",
      runId: "run-1",
    });

    await lock?.release();

    await expect(readDispatchLockInfo(lock?.path ?? "")).resolves.toBeUndefined();
    await expect(releaseDispatchLock(lock?.path)).resolves.toBeUndefined();
    await expect(releaseDispatchLock(undefined)).resolves.toBeUndefined();
  });

  it("reads undefined for missing or malformed lock info", async () => {
    const root = await createProjectRoot();
    const lockDir = await writeExistingLock(root, "{ broken");

    await expect(readDispatchLockInfo(lockDir)).resolves.toBeUndefined();
  });

  it("detects stale locks", () => {
    expect(isDispatchLockStale(undefined)).toBe(true);
    expect(isDispatchLockStale(lockInfo({ pid: -1 }))).toBe(true);
    expect(isDispatchLockStale(lockInfo({ startedAt: "not-a-date" }))).toBe(true);
    expect(isDispatchLockStale(lockInfo())).toBe(false);
  });

  it("reclaims a lock whose holder pid is dead", async () => {
    const root = await createProjectRoot();
    await writeExistingLock(root, lockInfo({ pid: -1, runId: "dead-run" }));

    const lock = await acquireDispatchLock({
      projectRoot: root,
      storyId: "STORY-123",
      runId: "run-2",
    });

    expect(lock?.info.runId).toBe("run-2");
  });

  it("reclaims a lock whose age exceeds the stale bound", async () => {
    const root = await createProjectRoot();
    await writeExistingLock(root, lockInfo({ startedAt: "2000-01-01T00:00:00.000Z" }));

    const lock = await acquireDispatchLock({
      projectRoot: root,
      storyId: "STORY-123",
      runId: "run-2",
      staleMs: 1,
    });

    expect(lock?.info.runId).toBe("run-2");
  });

  it("reclaims a lock with malformed holder metadata", async () => {
    const root = await createProjectRoot();
    await writeExistingLock(root, "not json");

    const lock = await acquireDispatchLock({
      projectRoot: root,
      storyId: "STORY-123",
      runId: "run-2",
    });

    expect(lock?.info.runId).toBe("run-2");
  });

  it("rejects invalid acquire requests", async () => {
    const root = await createProjectRoot();

    await expect(
      acquireDispatchLock({ projectRoot: root, storyId: "STORY-123", runId: " " }),
    ).rejects.toThrow(RangeError);
    await expect(
      acquireDispatchLock({ projectRoot: root, storyId: "STORY-123", runId: "run", staleMs: -1 }),
    ).rejects.toThrow(RangeError);
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

describe("dispatch lock debug logging", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("emits lock.acquire and lock.release events for a fresh lock", async () => {
    const root = await createProjectRoot();
    const write = captureDebug();

    const lock = await acquireDispatchLock({
      projectRoot: root,
      storyId: "STORY-123",
      runId: "run-1",
    });
    await lock?.release();

    const events = debugEvents(write);
    expect(events.find((entry) => entry["event"] === "lock.acquire")).toMatchObject({
      outcome: "acquired",
      storyId: "STORY-123",
      runId: "run-1",
      path: getDispatchLockDir(root, "STORY-123"),
    });
    expect(events.find((entry) => entry["event"] === "lock.release")).toMatchObject({
      path: getDispatchLockDir(root, "STORY-123"),
    });
  });

  it("emits a held verdict with holder context when the lock is live", async () => {
    const root = await createProjectRoot();
    const lockDir = await writeExistingLock(root, lockInfo({ runId: "run-live" }));
    const write = captureDebug();

    const lock = await acquireDispatchLock({
      projectRoot: root,
      storyId: "STORY-123",
      runId: "run-2",
    });
    expect(lock).toBeUndefined();

    expect(debugEvents(write).find((entry) => entry["event"] === "lock.acquire")).toMatchObject({
      outcome: "held",
      storyId: "STORY-123",
      runId: "run-2",
      path: lockDir,
      holderPid: process.pid,
      holderRunId: "run-live",
    });
  });

  it("emits a reclaimed verdict when a stale lock is taken over", async () => {
    const root = await createProjectRoot();
    await writeExistingLock(
      root,
      lockInfo({ runId: "run-old", startedAt: new Date(0).toISOString() }),
    );
    const write = captureDebug();

    const lock = await acquireDispatchLock({
      projectRoot: root,
      storyId: "STORY-123",
      runId: "run-3",
    });
    expect(lock).toBeDefined();

    const acquires = debugEvents(write).filter((entry) => entry["event"] === "lock.acquire");
    expect(acquires.at(-1)).toMatchObject({
      outcome: "reclaimed",
      storyId: "STORY-123",
      runId: "run-3",
    });
  });
});
