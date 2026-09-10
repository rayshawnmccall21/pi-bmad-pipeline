import { describe, expect, it } from "vitest";

import { computeRunDefDigest, runDefsEqualExceptStageTimeouts, type RunDef } from "./index.js";

const baseRunDef = (): RunDef => ({
  id: "sdlc",
  stages: [
    {
      id: "dev-story",
      kind: "agent",
      workflow: "dev-story",
      agent: "dev",
      gate: "code-review",
      onFail: "dev-story",
      timeout: 60,
      thinking: "high",
      extensions: ["./extension.ts"],
    },
    {
      id: "check",
      kind: "code",
      command: "npm",
      args: ["run", "check"],
      timeout: 120,
    },
  ],
});

describe("RunDef digest identity", () => {
  it("is stable across property insertion order and changes with semantic content", () => {
    const ordered: RunDef = {
      id: "sdlc",
      description: "Software delivery",
      stages: [
        {
          id: "dev-story",
          description: "Implement story",
          kind: "agent",
          workflow: "dev-story",
          agent: "dev",
          timeout: 60,
          thinking: "high",
          model: "claude-sonnet",
          budget: { maxTokens: 10_000, maxDollars: 2 },
          extensions: ["./extension.ts"],
          oPool: "delivery",
          oName: "developer",
          oTag: "story",
        },
        {
          id: "check",
          description: "Run checks",
          kind: "code",
          command: "npm",
          args: ["run", "check"],
          timeout: 120,
          onFail: "dev-story",
          findingsFile: ".pi/findings.json",
        },
      ],
    };
    const reordered: RunDef = {
      stages: [
        {
          oTag: "story",
          oName: "developer",
          oPool: "delivery",
          extensions: ["./extension.ts"],
          budget: { maxDollars: 2, maxTokens: 10_000 },
          model: "claude-sonnet",
          thinking: "high",
          timeout: 60,
          agent: "dev",
          workflow: "dev-story",
          kind: "agent",
          description: "Implement story",
          id: "dev-story",
        },
        {
          findingsFile: ".pi/findings.json",
          onFail: "dev-story",
          timeout: 120,
          args: ["run", "check"],
          command: "npm",
          kind: "code",
          description: "Run checks",
          id: "check",
        },
      ],
      description: "Software delivery",
      id: "sdlc",
    };
    const orderedDigest = computeRunDefDigest(ordered);

    expect(computeRunDefDigest(reordered)).toBe(orderedDigest);
    expect(orderedDigest).toMatch(/^[0-9a-f]{64}$/u);

    const changedCommand: RunDef = {
      ...reordered,
      stages: reordered.stages.map((stage) =>
        stage.kind === "code" ? { ...stage, command: "pnpm" } : stage,
      ),
    };

    expect(computeRunDefDigest(changedCommand)).not.toBe(orderedDigest);
  });
});

describe("RunDef timeout-only identity", () => {
  it("treats omitted, added, and changed stage timeouts as equal", () => {
    const previous = baseRunDef();
    const current: RunDef = {
      ...previous,
      stages: [
        { ...previous.stages[0]!, timeout: 600 },
        { id: "check", kind: "code", command: "npm", args: ["run", "check"] },
      ],
    };

    expect(runDefsEqualExceptStageTimeouts(previous, current)).toBe(true);
  });

  it.each([
    ["id", (runDef: RunDef): RunDef => ({ ...runDef, id: "other" })],
    [
      "workflow",
      (runDef: RunDef): RunDef => ({
        ...runDef,
        stages: [{ ...runDef.stages[0]!, workflow: "other" } as RunDef["stages"][number]],
      }),
    ],
    [
      "gate/onFail",
      (runDef: RunDef): RunDef => ({
        ...runDef,
        stages: [
          { ...runDef.stages[0]!, gate: "other", onFail: "other" } as RunDef["stages"][number],
        ],
      }),
    ],
    [
      "extensions/thinking",
      (runDef: RunDef): RunDef => ({
        ...runDef,
        stages: [
          {
            ...runDef.stages[0]!,
            thinking: "low",
            extensions: ["./other.ts"],
          } as RunDef["stages"][number],
        ],
      }),
    ],
    [
      "stage order",
      (runDef: RunDef): RunDef => ({ ...runDef, stages: [...runDef.stages].reverse() }),
    ],
  ] as const)("rejects a non-timeout %s change", (_name, change) => {
    const previous = baseRunDef();

    expect(runDefsEqualExceptStageTimeouts(previous, change(previous))).toBe(false);
  });
});
