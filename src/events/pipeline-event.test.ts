import { describe, expect, it } from "vitest";

import {
  createPipelineEventEmitter,
  PipelineEventError,
  serializePipelineEvent,
  type PipelineCliEvent,
  type PipelineCliEventFields,
  type PipelineCliEventType,
} from "./index.js";

const fixedDate = new Date("2026-08-05T12:00:00.000Z");
const fixedIso = "2026-08-05T12:00:00.000Z";
const fixedClock = (): Date => fixedDate;

const captureSink = (): { lines: string[]; write: (line: string) => void } => {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
};

const parseLine = (line: string): Record<string, unknown> =>
  JSON.parse(line) as Record<string, unknown>;

describe("serializePipelineEvent", () => {
  const progressEvent: PipelineCliEvent = {
    event: "progress",
    ts: fixedIso,
    storyId: "STORY-1",
    message: "compiling rundef",
  };

  it("returns single-line JSON that round-trips to the event", () => {
    const line = serializePipelineEvent(progressEvent);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual(progressEvent);
  });

  it("escapes embedded newlines so the output stays one line", () => {
    const line = serializePipelineEvent({
      event: "stage.finished",
      ts: fixedIso,
      storyId: "STORY-1",
      stageId: "dev-story",
      attempt: 1,
      kind: "failed",
      passed: false,
      exitCode: null,
      durationMs: 42,
      reason: "line one\nline two",
    });
    expect(line).not.toContain("\n");
    expect(parseLine(line)["reason"]).toBe("line one\nline two");
  });

  it("redacts credential-looking substrings", () => {
    const line = serializePipelineEvent({
      event: "progress",
      ts: fixedIso,
      storyId: "STORY-1",
      message: "Authorization: Bearer abcdef1234567890abcdef1234567890",
    });
    expect(line).not.toContain("abcdef1234567890");
    expect(line).toContain("[REDACTED]");
  });
});

describe("createPipelineEventEmitter", () => {
  it("throws a typed error for a blank story id", () => {
    const sink = captureSink();
    const build = (): unknown => createPipelineEventEmitter({ sink, storyId: "  " });
    expect(build).toThrow(PipelineEventError);
    try {
      build();
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineEventError);
      expect((error as PipelineEventError).code).toBe("invalid-story-id");
      expect((error as PipelineEventError).name).toBe("PipelineEventError");
    }
  });

  it("writes one parseable line per emit with envelope fields stamped", () => {
    const sink = captureSink();
    const emitter = createPipelineEventEmitter({ sink, storyId: "STORY-1", now: fixedClock });

    const event = emitter.emit("stage.started", { stageId: "dev-story", attempt: 2 });

    expect(sink.lines).toHaveLength(1);
    const parsed = parseLine(sink.lines[0]!);
    expect(parsed).toEqual({
      event: "stage.started",
      ts: fixedIso,
      storyId: "STORY-1",
      stageId: "dev-story",
      attempt: 2,
    });
    expect(event.event).toBe("stage.started");
    expect(event.ts).toBe(fixedIso);
    expect(event.storyId).toBe("STORY-1");
  });

  it("defaults to the system clock when no clock is injected", () => {
    const sink = captureSink();
    const emitter = createPipelineEventEmitter({ sink, storyId: "STORY-1" });
    const event = emitter.emit("progress", { message: "working" });
    expect(new Date(event.ts).toISOString()).toBe(event.ts);
  });

  it("returns a deep-frozen event and defensively copies array fields", () => {
    const sink = captureSink();
    const emitter = createPipelineEventEmitter({ sink, storyId: "STORY-1", now: fixedClock });
    const findings: string[] = ["missing test"];

    const event = emitter.emit("gate.decision", {
      stageId: "e2e-verify",
      gate: "e2e-verify",
      passed: false,
      reason: "verdict failed",
      findings,
    });

    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.findings)).toBe(true);
    findings.push("mutated after emit");
    expect(event.findings).toEqual(["missing test"]);
  });

  it("redacts field values in both the written line and the returned event", () => {
    const sink = captureSink();
    const emitter = createPipelineEventEmitter({ sink, storyId: "STORY-1", now: fixedClock });

    const event = emitter.emit("error", {
      code: "internal",
      message: "boom with Bearer abcdef1234567890abcdef1234567890",
    });

    expect(sink.lines[0]).not.toContain("abcdef1234567890");
    expect(event.message).toContain("[REDACTED]");
    expect(event.message).not.toContain("abcdef1234567890");
  });

  it("never lets variant fields override envelope fields", () => {
    const sink = captureSink();
    const emitter = createPipelineEventEmitter({ sink, storyId: "STORY-1", now: fixedClock });
    const hostile = {
      message: "hello",
      event: "error",
      storyId: "EVIL",
      ts: "1999-01-01T00:00:00.000Z",
    } as unknown as PipelineCliEventFields<"progress">;

    const event = emitter.emit("progress", hostile);

    expect(event.event).toBe("progress");
    expect(event.storyId).toBe("STORY-1");
    expect(event.ts).toBe(fixedIso);
  });

  it("omits absent optional fields and redacts present ones", () => {
    const sink = captureSink();
    const emitter = createPipelineEventEmitter({ sink, storyId: "STORY-1", now: fixedClock });

    emitter.emit("budget.decision", {
      scope: "run",
      withinBudget: true,
      reason: "within run budget",
    });
    emitter.emit("result", {
      status: "needs-attention",
      stagesRun: [],
      regressions: 1,
      durationMs: 5,
      error: "boom with Bearer abcdef1234567890abcdef1234567890",
    });

    const budget = parseLine(sink.lines[0]!);
    expect("stageId" in budget).toBe(false);
    const result = parseLine(sink.lines[1]!);
    expect(result["error"]).toContain("[REDACTED]");
    expect(sink.lines[1]).not.toContain("abcdef1234567890");
  });

  it("returns a frozen emitter", () => {
    const sink = captureSink();
    const emitter = createPipelineEventEmitter({ sink, storyId: "STORY-1" });
    expect(Object.isFrozen(emitter)).toBe(true);
  });

  it("emits every variant as parseable single-line JSON", () => {
    const sink = captureSink();
    const emitter = createPipelineEventEmitter({ sink, storyId: "STORY-9", now: fixedClock });

    emitter.emit("run.started", { rundefId: "sdlc", specFile: "specs/story-9.md" });
    emitter.emit("stage.started", { stageId: "dev-story", attempt: 1 });
    emitter.emit("stage.finished", {
      stageId: "dev-story",
      attempt: 1,
      kind: "passed",
      passed: true,
      exitCode: 0,
      durationMs: 1234,
      reason: "stage passed",
    });
    emitter.emit("gate.decision", {
      stageId: "e2e-verify",
      gate: "e2e-verify",
      passed: true,
      reason: "verdict passed",
      findings: [],
    });
    emitter.emit("budget.decision", {
      scope: "stage",
      stageId: "dev-story",
      withinBudget: false,
      reason: "stage budget exceeded",
    });
    emitter.emit("evidence.finished", { passed: true, failedCommands: [] });
    emitter.emit("pr.opened", {
      prUrl: "https://github.com/acme/repo/pull/7",
      prNumber: 7,
      branch: "story/STORY-9",
    });
    emitter.emit("merge.decision", { decision: "merge-allowed", blockers: [] });
    emitter.emit("progress", { message: "compiling rundef" });
    emitter.emit("result", {
      status: "passed",
      stagesRun: ["dev-story"],
      regressions: 0,
      durationMs: 9876,
    });
    emitter.emit("error", { code: "internal", message: "boom" });

    const expectedTypes: readonly PipelineCliEventType[] = [
      "run.started",
      "stage.started",
      "stage.finished",
      "gate.decision",
      "budget.decision",
      "evidence.finished",
      "pr.opened",
      "merge.decision",
      "progress",
      "result",
      "error",
    ];
    expect(sink.lines).toHaveLength(expectedTypes.length);
    for (const [index, line] of sink.lines.entries()) {
      expect(line).not.toContain("\n");
      const parsed = parseLine(line);
      expect(parsed["event"]).toBe(expectedTypes[index]);
      expect(parsed["storyId"]).toBe("STORY-9");
      expect(parsed["ts"]).toBe(fixedIso);
    }
  });
});
