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

import type { PayloadGate, PayloadGateRegistry, RunDef } from "./index.js";

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
    expect(stages[1]?.payloadGate).toBe(passGate);
  });

  it("resolves payload gates through an injected registry", () => {
    const registry: PayloadGateRegistry = {
      resolve: (name) => (name === "e2e-verify" ? passGate : undefined),
    };

    const stages = compileRunDef(gatedRunDef(), { registry });

    expect(stages[1]?.payloadGate).toBe(passGate);
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

    expect(stages[0]?.thinking).toBe("high");
    expect(stages[0]?.budget).toEqual({ maxTokens: 1000, maxDollars: 0 });
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

    expect(stages[0]?.budget).toEqual({ maxTokens: 1000 });
    expect(stages[0]?.budget).not.toBe(runDef.stages[0]?.budget);
    expect(Object.isFrozen(stages[0]?.budget)).toBe(true);
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
    }
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
