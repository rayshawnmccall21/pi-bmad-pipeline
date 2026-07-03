import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEBUG_LOG_PREFIX,
  debugLog,
  isPipelineDebugEnabled,
  PIPELINE_DEBUG_ENV_VAR,
} from "./index.js";

const captureSink = (): { lines: string[]; write: (line: string) => void } => {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
};

const parseLine = (line: string): Record<string, unknown> => {
  expect(line.startsWith(`${DEBUG_LOG_PREFIX} `)).toBe(true);
  return JSON.parse(line.slice(DEBUG_LOG_PREFIX.length + 1)) as Record<string, unknown>;
};

describe("isPipelineDebugEnabled", () => {
  it("is disabled when the env var is unset", () => {
    expect(isPipelineDebugEnabled({})).toBe(false);
  });

  it.each(["", " ", "0", "false", "FALSE"])("is disabled for %j", (value) => {
    expect(isPipelineDebugEnabled({ [PIPELINE_DEBUG_ENV_VAR]: value })).toBe(false);
  });

  it.each(["1", "true", "yes", "verbose"])("is enabled for %j", (value) => {
    expect(isPipelineDebugEnabled({ [PIPELINE_DEBUG_ENV_VAR]: value })).toBe(true);
  });
});

describe("debugLog", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("writes nothing when debug logging is disabled", () => {
    const sink = captureSink();
    debugLog("stage.spawn", { storyId: "STORY-1" }, { env: {}, write: sink.write });
    expect(sink.lines).toEqual([]);
  });

  it("writes one prefixed JSON line with event, timestamp, and fields", () => {
    const sink = captureSink();
    debugLog(
      "stage.spawn",
      { storyId: "STORY-1", attempt: 2, args: ["--mode", "json"], stage: null },
      { env: { [PIPELINE_DEBUG_ENV_VAR]: "1" }, write: sink.write },
    );

    expect(sink.lines).toHaveLength(1);
    const parsed = parseLine(sink.lines[0]!);
    expect(parsed["event"]).toBe("stage.spawn");
    expect(typeof parsed["ts"]).toBe("string");
    expect(parsed["storyId"]).toBe("STORY-1");
    expect(parsed["attempt"]).toBe(2);
    expect(parsed["args"]).toEqual(["--mode", "json"]);
    expect(parsed["stage"]).toBeNull();
  });

  it("redacts credential-looking field values", () => {
    const sink = captureSink();
    debugLog(
      "stage.envelope",
      { reason: "Authorization: Bearer abcdef1234567890abcdef1234567890" },
      { env: { [PIPELINE_DEBUG_ENV_VAR]: "1" }, write: sink.write },
    );

    expect(sink.lines[0]).not.toContain("abcdef1234567890");
    expect(sink.lines[0]).toContain("[REDACTED]");
  });

  it("defaults to process.env gating and a process.stderr sink", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    vi.stubEnv(PIPELINE_DEBUG_ENV_VAR, "");
    debugLog("lock.release", { path: "/tmp/lock" });
    expect(write).not.toHaveBeenCalled();

    vi.stubEnv(PIPELINE_DEBUG_ENV_VAR, "1");
    debugLog("lock.release", { path: "/tmp/lock" });
    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(line.endsWith("\n")).toBe(true);
    expect(parseLine(line.trimEnd())["event"]).toBe("lock.release");
  });
});
