import { describe, expect, it } from "vitest";

import { CLI_USAGE_LINES, parseCliArgs } from "./cli-args.js";

describe("CLI_USAGE_LINES", () => {
  it("is frozen and lists only run, help, and version", () => {
    expect(Object.isFrozen(CLI_USAGE_LINES)).toBe(true);
    expect(CLI_USAGE_LINES.join("\n")).toContain("run <rundef-id>");
    expect(CLI_USAGE_LINES.join("\n")).not.toMatch(/audit|iso|merge|no-pr/u);
  });
});

describe("parseCliArgs", () => {
  it("parses every run option", () => {
    expect(
      parseCliArgs([
        "run",
        "custom",
        "--story-id",
        "S-1",
        "--spec-file",
        "s.md",
        "--project-root",
        "/repo",
        "--model",
        "m",
        "--thinking",
        "high",
        "--max-regressions",
        "2",
        "--jsonl",
      ]),
    ).toEqual({
      kind: "run",
      rundefId: "custom",
      storyId: "S-1",
      specFile: "s.md",
      projectRoot: "/repo",
      model: "m",
      thinking: "high",
      maxRegressions: 2,
      jsonl: true,
    });
  });

  it("parses a minimal run command", () => {
    expect(parseCliArgs(["run", "sdlc", "--story-id", "S-1", "--spec-file", "s.md"])).toEqual({
      kind: "run",
      rundefId: "sdlc",
      storyId: "S-1",
      specFile: "s.md",
      jsonl: false,
    });
  });

  it("defaults storyId to the rundef-id when --story-id is omitted", () => {
    expect(parseCliArgs(["run", "sdlc"])).toEqual({
      kind: "run",
      rundefId: "sdlc",
      storyId: "sdlc",
      specFile: "",
      jsonl: false,
    });
  });

  it("defaults specFile to empty string when --spec-file is omitted", () => {
    expect(parseCliArgs(["run", "sdlc", "--story-id", "S-1"])).toEqual({
      kind: "run",
      rundefId: "sdlc",
      storyId: "S-1",
      specFile: "",
      jsonl: false,
    });
  });

  it("defaults storyId to the rundef-id when only --spec-file is given", () => {
    expect(parseCliArgs(["run", "sdlc", "--spec-file", "s.md"])).toEqual({
      kind: "run",
      rundefId: "sdlc",
      storyId: "sdlc",
      specFile: "s.md",
      jsonl: false,
    });
  });

  it.each([
    [[], "missing-command"],
    [["unknown"], "unknown-command"],
    [["run", "sdlc", "--story-id", "S", "--spec-file", "s", "--bad"], "unknown-option"],
    [["run", "sdlc", "--story-id"], "missing-option-value"],
    [["run", "--story-id", "S", "--spec-file", "s"], "missing-positional"],
    [["run", "one", "two", "--story-id", "S", "--spec-file", "s"], "unexpected-positional"],
    [
      ["run", "one", "--story-id", "S", "--spec-file", "s", "--max-regressions", "-1"],
      "invalid-number",
    ],
    [["run", "one", "--story-id", "S", "--spec-file", "s", "--no-pr"], "unknown-option"],
  ] as const)("returns %s as %s", (argv, code) => {
    expect(parseCliArgs(argv)).toMatchObject({ kind: "parse-error", code });
  });

  it.each(["audit", "iso", "merge"])("rejects removed command %s", (command) => {
    expect(parseCliArgs([command])).toMatchObject({ kind: "parse-error", code: "unknown-command" });
  });

  it.each([
    ["help", "help"],
    ["--help", "help"],
    ["-h", "help"],
    ["version", "version"],
    ["--version", "version"],
  ])("recognizes %s", (word, kind) => {
    expect(parseCliArgs([word])).toEqual({ kind });
  });
});
