import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_STAGE_TIMEOUT_SECONDS,
  RunDefCompileError,
  RunDefValidationError,
  clearPayloadGateRegistry,
  compileRunDef,
  compileValidatedRunDef,
  registerPayloadGate,
} from "./index.js";

import type {
  CompiledAgentStage,
  CompiledCodeStage,
  CompiledStageDef,
  PayloadGate,
  PayloadGateRegistry,
  RunDef,
} from "./index.js";

const passGate: PayloadGate = (): { passed: boolean } => ({ passed: true });

const minimalRunDef = (): RunDef => ({
  id: "sdlc",
  stages: [{ id: "create-story", kind: "agent", workflow: "create-story", agent: "sm" }],
});

const gatedRunDef = (): RunDef => ({
  id: "sdlc",
  stages: [
    { id: "dev-story", kind: "agent", workflow: "dev-story", agent: "dev", timeout: 3600 },
    {
      id: "e2e-verify",
      kind: "agent",
      workflow: "e2e-verify",
      agent: "tea",
      gate: "e2e-verify",
      onFail: "dev-story",
      timeout: 7200,
    },
  ],
});

const agentStageAt = (stages: readonly CompiledStageDef[], index: number): CompiledAgentStage => {
  const stage = stages[index];
  expect(stage?.kind).toBe("agent");
  if (stage?.kind !== "agent") throw new Error("expected compiled agent stage");
  return stage;
};

const codeStageAt = (stages: readonly CompiledStageDef[], index: number): CompiledCodeStage => {
  const stage = stages[index];
  expect(stage?.kind).toBe("code");
  if (stage?.kind !== "code") throw new Error("expected compiled code stage");
  return stage;
};

describe("RunDef compilation", () => {
  beforeEach(() => {
    clearPayloadGateRegistry();
  });

  it("compiles a minimal RunDef with the default timeout", () => {
    const stages = compileRunDef(minimalRunDef());

    expect(stages).toEqual([
      {
        id: "create-story",
        kind: "agent",
        workflow: "create-story",
        agent: "sm",
        index: 0,
        timeoutSeconds: DEFAULT_STAGE_TIMEOUT_SECONDS,
      },
    ]);
  });

  it("preserves an optional agent stage description", () => {
    const runDef = minimalRunDef();
    const stages = compileRunDef({
      ...runDef,
      stages: [{ ...runDef.stages[0]!, description: "Create the next story" }],
    });

    expect(stages[0]?.description).toBe("Create the next story");
  });

  it("returns frozen compiled stages and a frozen stage array", () => {
    const stages = compileRunDef(minimalRunDef());

    expect(Object.isFrozen(stages)).toBe(true);
    expect(Object.isFrozen(stages[0])).toBe(true);
  });

  it("preserves execution order and assigns zero-based indexes", () => {
    const runDef: RunDef = {
      id: "sdlc",
      stages: [
        { id: "create-story", kind: "agent", workflow: "create-story", agent: "sm" },
        { id: "e2e-plan", kind: "agent", workflow: "e2e-plan", agent: "tea" },
        { id: "dev-story", kind: "agent", workflow: "dev-story", agent: "dev" },
      ],
    };

    const stages = compileRunDef(runDef);

    expect(stages.map((s) => s.id)).toEqual(["create-story", "e2e-plan", "dev-story"]);
    expect(stages.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("preserves explicit stage timeouts", () => {
    registerPayloadGate("e2e-verify", passGate);

    const stages = compileRunDef(gatedRunDef());

    expect(stages[0]?.timeoutSeconds).toBe(3600);
    expect(stages[1]?.timeoutSeconds).toBe(7200);
  });

  it("supports overriding the default timeout", () => {
    const stages = compileRunDef(minimalRunDef(), { defaultTimeoutSeconds: 42 });

    expect(stages[0]?.timeoutSeconds).toBe(42);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "rejects invalid default timeout %s",
    (defaultTimeoutSeconds: number) => {
      expect(() => compileRunDef(minimalRunDef(), { defaultTimeoutSeconds })).toThrow(RangeError);
    },
  );

  it("resolves payload gates through the module-level registry", () => {
    registerPayloadGate("e2e-verify", passGate);

    const stages = compileRunDef(gatedRunDef());

    expect(stages[1]).toMatchObject({
      id: "e2e-verify",
      payloadGateName: "e2e-verify",
      onFail: "dev-story",
    });
    expect(agentStageAt(stages, 1).payloadGate).toBe(passGate);
  });

  it("resolves payload gates through an injected registry", () => {
    const registry: PayloadGateRegistry = {
      resolve: (name) => (name === "e2e-verify" ? passGate : undefined),
    };

    const stages = compileRunDef(gatedRunDef(), { registry });

    expect(agentStageAt(stages, 1).payloadGate).toBe(passGate);
  });

  it("throws RunDefCompileError for an unregistered payload gate", () => {
    expect(() => compileRunDef(gatedRunDef())).toThrow(RunDefCompileError);

    try {
      compileRunDef(gatedRunDef());
      expect.unreachable("compileRunDef should throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(RunDefCompileError);
      if (error instanceof RunDefCompileError) {
        expect(error.code).toBe("unregistered-payload-gate");
        expect(error.runDefId).toBe("sdlc");
        expect(error.stageId).toBe("e2e-verify");
        expect(error.gateName).toBe("e2e-verify");
        expect(error.message).toBe(
          'RunDef "sdlc" stage "e2e-verify" references unregistered payload gate "e2e-verify".',
        );
      }
    }
  });

  it("preserves thinking and budget options", () => {
    const runDef: RunDef = {
      id: "sdlc",
      stages: [
        {
          id: "code-review",
          kind: "agent",
          workflow: "code-review",
          agent: "dev",
          thinking: "high",
          budget: { maxTokens: 1000, maxDollars: 0 },
        },
      ],
    };

    const stages = compileRunDef(runDef);

    const compiledStage = agentStageAt(stages, 0);
    expect(compiledStage.thinking).toBe("high");
    expect(compiledStage.budget).toEqual({ maxTokens: 1000, maxDollars: 0 });
  });

  it("copies and freezes compiled budget objects", () => {
    const runDef: RunDef = {
      id: "sdlc",
      stages: [
        {
          id: "dev-story",
          kind: "agent",
          workflow: "dev-story",
          agent: "dev",
          budget: { maxTokens: 1000 },
        },
      ],
    };

    const stages = compileRunDef(runDef);

    const compiledStage = agentStageAt(stages, 0);
    expect(compiledStage.budget).toEqual({ maxTokens: 1000 });
    expect(compiledStage.budget).not.toBe(
      (runDef.stages[0] as unknown as Record<string, unknown>)["budget"],
    );
    expect(Object.isFrozen(compiledStage.budget)).toBe(true);
  });

  it("omits optional compiled fields when the source stage omits them", () => {
    const stages = compileRunDef(minimalRunDef());
    const [stage] = stages;

    expect(stage).toBeDefined();
    if (stage !== undefined) {
      expect("payloadGateName" in stage).toBe(false);
      expect("payloadGate" in stage).toBe(false);
      expect("onFail" in stage).toBe(false);
      expect("thinking" in stage).toBe(false);
      expect("budget" in stage).toBe(false);
      expect("extensions" in stage).toBe(false);
      expect("oPool" in stage).toBe(false);
      expect("oName" in stage).toBe(false);
      expect("oTag" in stage).toBe(false);
    }
  });

  it("copies and freezes compiled extensions", () => {
    const runDef = minimalRunDef();
    const sources = ["/ext/obs.ts", "/ext/subagents.ts"];
    const stages = compileRunDef({
      ...runDef,
      stages: [
        {
          ...runDef.stages[0]!,
          extensions: sources,
        },
      ],
    });

    const compiledStage = agentStageAt(stages, 0);
    expect(compiledStage.extensions).toEqual(["/ext/obs.ts", "/ext/subagents.ts"]);
    expect(compiledStage.extensions).not.toBe(sources);
    expect(Object.isFrozen(compiledStage.extensions)).toBe(true);
  });

  it("does not mutate the input RunDef", () => {
    const runDef = minimalRunDef();
    const before = JSON.stringify(runDef);

    compileRunDef(runDef);

    expect(JSON.stringify(runDef)).toBe(before);
  });

  it("validates unknown candidates before compilation", () => {
    expect(() => compileRunDef({ id: "sdlc", stages: [] })).toThrow(RunDefValidationError);
  });

  it("compiles an already validated RunDef", () => {
    const stages = compileValidatedRunDef(minimalRunDef());

    expect(stages[0]?.id).toBe("create-story");
  });
});

describe("code stage compilation", () => {
  const codeRunDef = (): RunDef => ({
    id: "pipeline",
    stages: [{ id: "check", kind: "code", command: "npm", args: ["run", "check"], timeout: 1800 }],
  });

  it("compiles a code stage with command and args", () => {
    const stages = compileRunDef(codeRunDef());
    expect(stages[0]).toMatchObject({
      id: "check",
      kind: "code",
      command: "npm",
      args: ["run", "check"],
      index: 0,
    });
  });

  it("preserves an optional code stage description", () => {
    const runDef = codeRunDef();
    const stages = compileRunDef({
      ...runDef,
      stages: [{ ...runDef.stages[0]!, description: "Run project checks" }],
    });

    expect(stages[0]?.description).toBe("Run project checks");
  });

  it("freezes compiled args array", () => {
    const stages = compileRunDef(codeRunDef());
    expect(Object.isFrozen(codeStageAt(stages, 0).args)).toBe(true);
  });

  it("compiles args as empty frozen array when source omits args", () => {
    const stages = compileRunDef({
      id: "pipeline",
      stages: [{ id: "check", kind: "code", command: "npm" }],
    });
    const compiledStage = codeStageAt(stages, 0);
    expect(compiledStage.args).toEqual([]);
    expect(Object.isFrozen(compiledStage.args)).toBe(true);
  });

  it("skips payload gates for code stages", () => {
    const stages = compileRunDef(codeRunDef());
    expect("payloadGate" in (stages[0] as object)).toBe(false);
    expect("payloadGateName" in (stages[0] as object)).toBe(false);
  });

  it("returns frozen code stage object", () => {
    const stages = compileRunDef(codeRunDef());
    expect(Object.isFrozen(stages[0])).toBe(true);
  });

  it("applies default timeout when code stage omits timeout", () => {
    const stages = compileRunDef({
      id: "pipeline",
      stages: [{ id: "check", kind: "code", command: "npm" }],
    });
    expect(stages[0]?.timeoutSeconds).toBe(DEFAULT_STAGE_TIMEOUT_SECONDS);
  });
});
