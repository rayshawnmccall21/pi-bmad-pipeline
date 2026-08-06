import { describe, expect, it } from "vitest";

import { CLI_USAGE_LINES, parseCliArgs } from "./cli-args.js";
import type { CliParseError } from "./cli-command.js";

describe("CLI_USAGE_LINES", () => {
  it("is a frozen list naming every command", () => {
    expect(Object.isFrozen(CLI_USAGE_LINES)).toBe(true);
    const text = CLI_USAGE_LINES.join("\n");
    for (const command of ["run", "audit", "iso", "merge"]) {
      expect(text).toContain(command);
    }
  });
});

describe("parseCliArgs", () => {
  it("parses a fully specified run command", () => {
    const parsed = parseCliArgs([
      "run",
      "sdlc",
      "--story-id",
      "S-1",
      "--spec-file",
      "docs/spec.md",
      "--project-root",
      "/repo",
      "--model",
      "model-1",
      "--thinking",
      "high",
      "--max-regressions",
      "3",
      "--no-pr",
      "--jsonl",
    ]);
    expect(parsed).toEqual({
      kind: "run",
      rundefId: "sdlc",
      storyId: "S-1",
      specFile: "docs/spec.md",
      projectRoot: "/repo",
      model: "model-1",
      thinking: "high",
      maxRegressions: 3,
      openPr: false,
      jsonl: true,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("parses a minimal run command with defaults", () => {
    const parsed = parseCliArgs(["run", "sdlc", "--story-id", "S-1", "--spec-file", "spec.md"]);
    expect(parsed).toEqual({
      kind: "run",
      rundefId: "sdlc",
      storyId: "S-1",
      specFile: "spec.md",
      openPr: true,
      jsonl: false,
    });
  });

  it.each([
    [[], "missing-command"],
    [["deploy"], "unknown-command"],
    [["run", "sdlc", "--spec-file", "spec.md"], "missing-required-option"],
    [["run", "sdlc", "--story-id", "S-1"], "missing-required-option"],
    [["run", "--story-id", "S-1", "--spec-file", "spec.md"], "missing-positional"],
    [["run", "sdlc", "extra", "--story-id", "S-1", "--spec-file", "s"], "unexpected-positional"],
    [["run", "sdlc", "--story-id", "S-1", "--spec-file", "s", "--bogus", "x"], "unknown-option"],
    [["run", "sdlc", "--story-id", "S-1", "--spec-file"], "missing-option-value"],
    [["run", "sdlc", "--story-id", "--spec-file", "s"], "missing-option-value"],
    [
      ["run", "sdlc", "--story-id", "S-1", "--spec-file", "s", "--max-regressions", "abc"],
      "invalid-number",
    ],
    [["audit"], "missing-required-option"],
    [["audit", "--story-id", "S-1", "stray"], "unexpected-positional"],
    [["iso", "--story-id", "S-1"], "missing-required-option"],
    [["iso", "--spec-file", "spec.md"], "missing-required-option"],
    [["merge"], "missing-required-option"],
  ])("rejects %j with code %s", (argv, code) => {
    const parsed = parseCliArgs(argv);
    expect(parsed.kind).toBe("parse-error");
    expect((parsed as CliParseError).code).toBe(code);
    expect((parsed as CliParseError).message).not.toBe("");
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("parses audit with an explicit rundef id", () => {
    expect(parseCliArgs(["audit", "--story-id", "S-1", "--rundef", "custom"])).toEqual({
      kind: "audit",
      storyId: "S-1",
      rundefId: "custom",
    });
  });

  it("parses audit with and without a project root", () => {
    expect(parseCliArgs(["audit", "--story-id", "S-1"])).toEqual({
      kind: "audit",
      storyId: "S-1",
    });
    expect(parseCliArgs(["audit", "--story-id", "S-1", "--project-root", "/repo"])).toEqual({
      kind: "audit",
      storyId: "S-1",
      projectRoot: "/repo",
    });
  });

  it("parses iso and merge commands", () => {
    expect(parseCliArgs(["iso", "--story-id", "S-1", "--spec-file", "spec.md"])).toEqual({
      kind: "iso",
      storyId: "S-1",
      specFile: "spec.md",
    });
    expect(parseCliArgs(["merge", "--story-id", "S-1", "--project-root", "/repo"])).toEqual({
      kind: "merge",
      storyId: "S-1",
      projectRoot: "/repo",
    });
  });

  it("recognizes help and version requests", () => {
    expect(parseCliArgs(["help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["version"])).toEqual({ kind: "version" });
    expect(parseCliArgs(["--version"])).toEqual({ kind: "version" });
  });
});
