import { describe, expect, it } from "vitest";

import {
  CLI_EXIT_BLOCKED,
  CLI_EXIT_OK,
  createProcessLineSink,
  formatHumanEventLine,
  runStatusExitCode,
  type CliWritableStream,
} from "./cli-output.js";
import { serializePipelineEvent } from "./events/index.js";
import type { RunResultStatus } from "./state/index.js";

const fixedIso = "2026-08-05T12:34:56.000Z";

describe("runStatusExitCode", () => {
  it.each([
    ["passed", CLI_EXIT_OK],
    ["failed", CLI_EXIT_BLOCKED],
    ["needs-attention", CLI_EXIT_BLOCKED],
    ["needs-approval", CLI_EXIT_BLOCKED],
    ["paused", CLI_EXIT_BLOCKED],
  ])("maps %s to exit %d", (status, code) => {
    expect(runStatusExitCode(status as RunResultStatus)).toBe(code);
  });
});

describe("formatHumanEventLine", () => {
  it("renders envelope head plus generic key=value fields", () => {
    const line = serializePipelineEvent({
      event: "progress",
      ts: fixedIso,
      storyId: "S-1",
      message: "compiling rundef",
    });
    expect(formatHumanEventLine(line)).toBe("12:34:56 [S-1] progress message=compiling rundef");
  });

  it("renders numbers, booleans, nulls, and arrays", () => {
    const line = serializePipelineEvent({
      event: "stage.finished",
      ts: fixedIso,
      storyId: "S-1",
      stageId: "dev-story",
      attempt: 2,
      kind: "failed",
      passed: false,
      exitCode: null,
      durationMs: 42,
      reason: "gate failed",
    });
    expect(formatHumanEventLine(line)).toBe(
      "12:34:56 [S-1] stage.finished stageId=dev-story attempt=2 kind=failed " +
        "passed=false exitCode=null durationMs=42 reason=gate failed",
    );
  });

  it("joins array fields with commas", () => {
    const line = serializePipelineEvent({
      event: "gate.decision",
      ts: fixedIso,
      storyId: "S-1",
      stageId: "dev-story",
      gate: "code-review",
      passed: false,
      reason: "findings",
      findings: ["one", "two"],
    });
    expect(formatHumanEventLine(line)).toContain("findings=one,two");
  });

  it("renders nested objects as JSON", () => {
    expect(formatHumanEventLine('{"event":"x","extra":{"a":1}}')).toBe('x extra={"a":1}');
  });

  it("passes through non-JSON and non-object lines unchanged", () => {
    expect(formatHumanEventLine("plain text")).toBe("plain text");
    expect(formatHumanEventLine("[1,2]")).toBe("[1,2]");
    expect(formatHumanEventLine('"quoted"')).toBe('"quoted"');
  });

  it("omits envelope parts that are missing or malformed", () => {
    expect(formatHumanEventLine('{"foo":1}')).toBe("foo=1");
    expect(formatHumanEventLine('{"ts":"short","event":"progress","message":"m"}')).toBe(
      "progress message=m",
    );
    expect(formatHumanEventLine("{}")).toBe("");
  });
});

describe("createProcessLineSink", () => {
  it("appends a newline per written line", () => {
    const chunks: string[] = [];
    const stream: CliWritableStream = {
      write: (text: string): boolean => {
        chunks.push(text);
        return true;
      },
    };
    const sink = createProcessLineSink(stream);
    sink.write("one");
    sink.write("two");
    expect(chunks).toEqual(["one\n", "two\n"]);
    expect(Object.isFrozen(sink)).toBe(true);
  });
});
