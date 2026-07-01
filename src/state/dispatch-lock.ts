import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { isPipelineStateStoryId } from "./fs-state-store.js";

/** Relative project directory where per-story dispatch locks are stored. */
export const DISPATCH_LOCK_RELATIVE_DIR = ".pi/pipeline/locks" as const;

/** Metadata filename written inside a held dispatch lock directory. */
export const DISPATCH_LOCK_INFO_FILE_NAME = "info.json" as const;

const millisecondsPerSecond = 1000;
const secondsPerMinute = 60;
const minutesPerHour = 60;
const staleHours = 6;
const prettyJsonSpaces = 2;

/** Default age after which a held dispatch lock is reclaimable. */
export const DEFAULT_DISPATCH_LOCK_STALE_MS =
  staleHours * minutesPerHour * secondsPerMinute * millisecondsPerSecond;

/** Metadata stored for a held per-story dispatch lock. */
export interface DispatchLockInfo {
  /** Process id that acquired the lock. */
  readonly pid: number;

  /** Runner invocation id that acquired the lock. */
  readonly runId: string;

  /** ISO timestamp when the lock was acquired. */
  readonly startedAt: string;
}

/** Request for acquiring a per-story dispatch lock. */
export interface AcquireDispatchLockRequest {
  /** Project root directory. */
  readonly projectRoot: string;

  /** Story id being dispatched. */
  readonly storyId: string;

  /** Runner invocation id acquiring the lock. */
  readonly runId: string;

  /** Optional stale-lock age bound in milliseconds. */
  readonly staleMs?: number;
}

/** Acquired per-story dispatch lock handle. */
export interface DispatchLock {
  /** Story id protected by this lock. */
  readonly storyId: string;

  /** Absolute lock directory path. */
  readonly path: string;

  /** Metadata written for this lock holder. */
  readonly info: DispatchLockInfo;

  /**
   * Releases this lock best-effort.
   *
   * @returns Promise that resolves after release is attempted.
   *
   * @example
   * ```ts
   * await lock.release();
   * ```
   */
  release(): Promise<void>;
}

/**
 * Resolves the project directory that contains per-story dispatch locks.
 *
 * @param projectRoot - Project root directory.
 *
 * @returns Absolute project-local dispatch locks directory path.
 *
 * @throws RangeError When projectRoot is blank.
 *
 * @example
 * ```ts
 * const directory = getDispatchLocksDir(process.cwd());
 * ```
 */
export function getDispatchLocksDir(projectRoot: string): string {
  if (projectRoot.trim().length === 0) {
    throw new RangeError("Project root must not be blank.");
  }
  return resolve(projectRoot, ".pi", "pipeline", "locks");
}

/**
 * Resolves the lock directory path for a story.
 *
 * @param projectRoot - Project root directory.
 * @param storyId - Story id whose dispatch lock path should be resolved.
 *
 * @returns Absolute project-local lock directory path.
 *
 * @throws RangeError When projectRoot or storyId is invalid.
 *
 * @example
 * ```ts
 * const lockDir = getDispatchLockDir(process.cwd(), "STORY-123");
 * ```
 */
export function getDispatchLockDir(projectRoot: string, storyId: string): string {
  if (!isPipelineStateStoryId(storyId)) {
    throw new RangeError(`Invalid dispatch lock story id "${storyId}".`);
  }
  return join(getDispatchLocksDir(projectRoot), storyId);
}

/**
 * Reads dispatch lock holder metadata.
 *
 * @param lockDir - Absolute lock directory path.
 *
 * @returns Lock metadata, or undefined when missing or malformed.
 *
 * @example
 * ```ts
 * const info = await readDispatchLockInfo(lockDir);
 * ```
 */
export async function readDispatchLockInfo(lockDir: string): Promise<DispatchLockInfo | undefined> {
  try {
    return parseDispatchLockInfo(
      await readFile(join(lockDir, DISPATCH_LOCK_INFO_FILE_NAME), "utf8"),
    );
  } catch {
    return undefined;
  }
}

/**
 * Checks whether a dispatch lock is stale and reclaimable.
 *
 * @param info - Lock metadata to inspect.
 * @param staleMs - Age bound in milliseconds.
 *
 * @returns True when the lock holder is dead, missing, malformed, or too old.
 *
 * @example
 * ```ts
 * if (isDispatchLockStale(info, DEFAULT_DISPATCH_LOCK_STALE_MS)) {
 *   console.log("reclaimable");
 * }
 * ```
 */
export function isDispatchLockStale(
  info: DispatchLockInfo | undefined,
  staleMs = DEFAULT_DISPATCH_LOCK_STALE_MS,
): boolean {
  if (info === undefined || isPidDead(info.pid)) {
    return true;
  }
  const startedMs = Date.parse(info.startedAt);
  return Number.isNaN(startedMs) || Date.now() - startedMs >= staleMs;
}

/**
 * Acquires the per-story dispatch lock.
 *
 * @param request - Project, story, and invocation details for the lock.
 *
 * @returns A lock handle, or undefined when another live dispatch holds it.
 *
 * @throws RangeError When projectRoot, storyId, runId, or staleMs is invalid.
 *
 * @example
 * ```ts
 * const lock = await acquireDispatchLock({ projectRoot, storyId: "STORY-123", runId });
 * ```
 */
export async function acquireDispatchLock(
  request: AcquireDispatchLockRequest,
): Promise<DispatchLock | undefined> {
  assertAcquireRequest(request);
  const lockDir = getDispatchLockDir(request.projectRoot, request.storyId);
  const staleMs = request.staleMs ?? DEFAULT_DISPATCH_LOCK_STALE_MS;

  await mkdir(getDispatchLocksDir(request.projectRoot), { recursive: true });
  const info = await tryCreateAndWriteLock(lockDir, request.runId);
  if (info !== undefined) {
    return createDispatchLock(request.storyId, lockDir, info);
  }
  return reclaimAndAcquire({ lockDir, storyId: request.storyId, runId: request.runId, staleMs });
}

/**
 * Releases a previously acquired dispatch lock best-effort.
 *
 * @param lockDir - Lock directory path, or nullish when no lock was acquired.
 *
 * @returns Promise that resolves after release is attempted.
 *
 * @example
 * ```ts
 * await releaseDispatchLock(lock.path);
 * ```
 */
export async function releaseDispatchLock(lockDir: string | null | undefined): Promise<void> {
  if (lockDir === null || lockDir === undefined) {
    return;
  }
  await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
}

const assertAcquireRequest = (request: AcquireDispatchLockRequest): void => {
  if (request.runId.trim().length === 0) {
    throw new RangeError("Dispatch lock runId must not be blank.");
  }
  const staleMs = request.staleMs ?? DEFAULT_DISPATCH_LOCK_STALE_MS;
  if (!Number.isFinite(staleMs) || staleMs < 0) {
    throw new RangeError("Dispatch lock staleMs must be a non-negative finite number.");
  }
};

const createDispatchLock = (
  storyId: string,
  lockDir: string,
  info: DispatchLockInfo,
): DispatchLock =>
  Object.freeze({
    storyId,
    path: lockDir,
    info,
    release() {
      return releaseDispatchLock(lockDir);
    },
  } satisfies DispatchLock);

const createLockInfo = (runId: string): DispatchLockInfo =>
  Object.freeze({ pid: process.pid, runId, startedAt: new Date().toISOString() });

const tryCreateAndWriteLock = async (
  lockDir: string,
  runId: string,
): Promise<DispatchLockInfo | undefined> => {
  try {
    const info = createLockInfo(runId);
    await mkdir(lockDir);
    await writeLockInfo(lockDir, info);
    return info;
  } catch (error) {
    if (isErrnoCode(error, "EEXIST")) {
      return undefined;
    }
    await releaseDispatchLock(lockDir);
    throw error;
  }
};

const reclaimAndAcquire = async (
  request: Readonly<{ lockDir: string; storyId: string; runId: string; staleMs: number }>,
): Promise<DispatchLock | undefined> => {
  if (!isDispatchLockStale(await readDispatchLockInfo(request.lockDir), request.staleMs)) {
    return undefined;
  }
  await releaseDispatchLock(request.lockDir);
  const info = await tryCreateAndWriteLock(request.lockDir, request.runId);
  return info === undefined
    ? undefined
    : createDispatchLock(request.storyId, request.lockDir, info);
};

const writeLockInfo = async (lockDir: string, info: DispatchLockInfo): Promise<void> => {
  await writeFile(
    join(lockDir, DISPATCH_LOCK_INFO_FILE_NAME),
    `${JSON.stringify(info, null, prettyJsonSpaces)}\n`,
    "utf8",
  );
};

const parseDispatchLockInfo = (raw: string): DispatchLockInfo | undefined => {
  const parsed: unknown = JSON.parse(raw);
  if (!isLockInfoRecord(parsed)) {
    return undefined;
  }
  return Object.freeze({ pid: parsed.pid, runId: parsed.runId, startedAt: parsed.startedAt });
};

const isLockInfoRecord = (value: unknown): value is DispatchLockInfo =>
  typeof value === "object" &&
  value !== null &&
  "pid" in value &&
  typeof value.pid === "number" &&
  "runId" in value &&
  typeof value.runId === "string" &&
  "startedAt" in value &&
  typeof value.startedAt === "string";

const isPidDead = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isErrnoCode(error, "ESRCH");
  }
};

const isErrnoCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;
