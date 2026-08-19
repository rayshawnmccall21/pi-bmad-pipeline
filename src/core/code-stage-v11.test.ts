import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkStageDecision } from "./stage-decision.js";

const stageAt = <T>(stages: readonly T[], index: number): T => {
  const stage = stages[index];
  if (stage === undefined) {
    throw new Error(`missing stage at ${String(index)}`);
  }
  return stage;
};
import { routeStageDecision } from "./routing.js";
import { compileRunDef, validateRunDef } from "../rundef/index.js";
import { LocalCodeExecutor } from "../executors/code/index.js";

/**
 * Code-stage v1.1: a code stage's exit 1 becomes decision kind
 * "gate-failed" when it carries lifted findings, and code stages may
 * declare onFail without a gate — the exit code IS the gate. Everything
 * downstream (routing, transitions, prompt preamble) is source-agnostic.
 */

const codeRunDef = (stageOverrides: Record<string, unknown> = {}) => ({
  id: "review-loop",
  stages: [
    {
      id: "dev-story",
      kind: "agent",
      workflow: "dev-story",
      agent: "dev",
    },
    {
      id: "review-approval",
      kind: "code",
      command: "uv",
      args: ["run", "approval_gate.py"],
      ...stageOverrides,
    },
  ],
});

describe("v1.1 schema: onFail without gate on code stages", () => {
  it("accepts a code stage declaring onFail and findingsFile", () => {
    const result = validateRunDef(
      codeRunDef({ onFail: "dev-story", findingsFile: ".pi/artifacts/review-loop/findings.json" }),
    );
    expect(result.ok).toBe(true);
  });

  it("still rejects onFail targets that are not earlier stages", () => {
    const result = validateRunDef(codeRunDef({ onFail: "review-approval" }));
    expect(result.ok).toBe(false);
  });

  it("still rejects agent stages declaring onFail without gate", () => {
    const result = validateRunDef({
      id: "bad",
      stages: [
        { id: "a", kind: "agent", workflow: "w", agent: "dev" },
        { id: "b", kind: "agent", workflow: "w", agent: "dev", onFail: "a" },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("compiles onFail and findingsFile onto the compiled code stage", () => {
    const compiled = compileRunDef(
      codeRunDef({ onFail: "dev-story", findingsFile: "findings.json" }),
    );
    const stage = stageAt(compiled, 1);
    expect(stage.kind).toBe("code");
    if (stage.kind === "code") {
      expect(stage.onFail).toBe("dev-story");
      expect(stage.findingsFile).toBe("findings.json");
    }
  });
});

describe("v1.1 decision kernel: code exit 1 is the gate", () => {
  const codeStage = { id: "review-approval", kind: "code" as const };

  it("maps exit 1 with lifted findings to gate-failed", () => {
    const decision = checkStageDecision({
      stage: codeStage,
      result: {
        output: null,
        exitCode: 1,
        durationMs: 10,
        findings: ["[high] src/plan.ts:214 — race in updatePlan"],
      },
    });
    expect(decision.kind).toBe("gate-failed");
    expect(decision.passed).toBe(false);
    expect(decision.findings).toEqual(["[high] src/plan.ts:214 — race in updatePlan"]);
  });

  it("fails closed on exit 1 without findings (missing/invalid findings file)", () => {
    const decision = checkStageDecision({
      stage: codeStage,
      result: { output: null, exitCode: 1, durationMs: 10 },
    });
    expect(decision.kind).toBe("failed");
  });

  it("keeps exit >= 2 terminal even when findings are present", () => {
    const decision = checkStageDecision({
      stage: codeStage,
      result: { output: null, exitCode: 2, durationMs: 10, findings: ["x"] },
    });
    expect(decision.kind).toBe("failed");
  });

  it("does not change agent-stage exit semantics", () => {
    const decision = checkStageDecision({
      stage: { id: "dev-story", kind: "agent" as const },
      result: { output: null, exitCode: 1, durationMs: 10, findings: ["x"] },
    });
    expect(decision.kind).toBe("failed");
  });
});

describe("v1.1 routing: gate-failed code stage regresses to onFail", () => {
  it("regresses to the earlier stage with the shared counter", () => {
    const stages = compileRunDef(codeRunDef({ onFail: "dev-story" }));
    const route = routeStageDecision({
      stages,
      stage: stageAt(stages, 1),
      decision: {
        stageId: "review-approval",
        kind: "gate-failed",
        passed: false,
        reason: "blocking findings",
        findings: ["f"],
      },
      regressions: 0,
      maxRegressions: 6,
    });
    expect(route.action).toBe("regress");
    if (route.action === "regress") {
      expect(route.nextStageId).toBe("dev-story");
    }
  });

  it("stays terminal when the code stage has no onFail", () => {
    const stages = compileRunDef(codeRunDef());
    const route = routeStageDecision({
      stages,
      stage: stageAt(stages, 1),
      decision: {
        stageId: "review-approval",
        kind: "gate-failed",
        passed: false,
        reason: "blocking findings",
      },
      regressions: 0,
      maxRegressions: 6,
    });
    expect(route.action).toBe("fail");
  });
});

describe("v1.1 executor: findings file lift on exit 1", () => {
  let projectRoot: string;

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const runStage = async (findingsDoc: unknown, exitCode = 1) => {
    projectRoot = mkdtempSync(join(tmpdir(), "rg-v11-"));
    if (findingsDoc !== undefined) {
      writeFileSync(join(projectRoot, "findings.json"), JSON.stringify(findingsDoc));
    }
    const stages = compileRunDef(
      codeRunDef({
        command: "node",
        args: ["-e", `process.exit(${String(exitCode)})`],
        onFail: "dev-story",
        findingsFile: "findings.json",
      }),
    );
    const executor = new LocalCodeExecutor();
    return executor.execute({
      stage: stageAt(stages, 1),
      storyId: "STY-91",
      specFile: "",
      projectRoot,
      attempt: 1,
      signal: new AbortController().signal,
    });
  };

  it("lifts capped, formatted findings from stage-findings.v1", async () => {
    const result = await runStage({
      schema: "stage-findings.v1",
      findings: [
        {
          fingerprint: "PRRT_x",
          severity: "high",
          file: "src/plan.ts",
          line: 214,
          text: "race in updatePlan",
        },
      ],
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings?.[0]).toContain("src/plan.ts");
    expect(result.findings?.[0]).toContain("race in updatePlan");
  });

  it("omits findings when the file is missing (decision fails closed)", async () => {
    const result = await runStage(undefined);
    expect(result.exitCode).toBe(1);
    expect(result.findings).toBeUndefined();
  });

  it("omits findings when the schema marker is wrong", async () => {
    const result = await runStage({ schema: "nope", findings: [] });
    expect(result.findings).toBeUndefined();
  });

  it("does not lift on exit 0", async () => {
    const result = await runStage(
      {
        schema: "stage-findings.v1",
        findings: [{ fingerprint: "f", severity: "high", text: "x" }],
      },
      0,
    );
    expect(result.exitCode).toBe(0);
    expect(result.findings).toBeUndefined();
  });

  it("caps the number of lifted findings at 50", async () => {
    const result = await runStage({
      schema: "stage-findings.v1",
      findings: Array.from({ length: 80 }, (_, i) => ({
        fingerprint: `f${String(i)}`,
        severity: "high",
        text: `finding ${String(i)}`,
      })),
    });
    expect(result.findings).toHaveLength(50);
  });
});
