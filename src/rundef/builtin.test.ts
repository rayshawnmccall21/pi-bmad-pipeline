import { beforeEach, describe, expect, it } from "vitest";

import {
  SDLC_RUNDEF,
  SDLC_RUNDEF_ID,
  BUILTIN_RUNDEF_IDS,
  clearPayloadGateRegistry,
  compileRunDef,
  isBuiltinRunDefId,
  listBuiltinRunDefIds,
  parseRunDef,
  registerPayloadGate,
  resolveBuiltinRunDef,
  resolveRunDef,
} from "./index.js";

import type { PayloadGate } from "./index.js";

const passGate: PayloadGate = (): { passed: boolean } => ({ passed: true });

describe("built-in RunDefs", () => {
  beforeEach(() => {
    clearPayloadGateRegistry();
  });

  it("exports the canonical SDLC RunDef id", () => {
    expect(SDLC_RUNDEF_ID).toBe("sdlc");
  });

  it("exports the exact built-in SDLC stage table", () => {
    expect(SDLC_RUNDEF).toEqual({
      id: "sdlc",
      stages: [
        {
          id: "create-story",
          kind: "agent",
          workflow: "create-story",
          agent: "sm",
          timeout: 1800,
        },
        {
          id: "e2e-plan",
          kind: "agent",
          workflow: "e2e-plan",
          agent: "tea",
          timeout: 1800,
        },
        {
          id: "dev-story",
          kind: "agent",
          workflow: "dev-story",
          agent: "dev",
          timeout: 3600,
        },
        {
          id: "e2e-verify",
          kind: "agent",
          workflow: "e2e-verify",
          agent: "tea",
          gate: "e2e-verify",
          onFail: "dev-story",
          timeout: 7200,
        },
        {
          id: "code-review",
          kind: "agent",
          workflow: "code-review",
          agent: "dev",
          gate: "code-review",
          onFail: "dev-story",
          thinking: "high",
          timeout: 1800,
        },
        {
          id: "docs",
          kind: "agent",
          workflow: "docs",
          agent: "architect",
          thinking: "high",
          timeout: 1800,
        },
      ],
    });
  });

  it("keeps the built-in SDLC RunDef valid under the schema invariants", () => {
    expect(parseRunDef(SDLC_RUNDEF)).toBe(SDLC_RUNDEF);
  });

  it("freezes the built-in SDLC RunDef, stage array, and stages", () => {
    expect(Object.isFrozen(SDLC_RUNDEF)).toBe(true);
    expect(Object.isFrozen(SDLC_RUNDEF.stages)).toBe(true);

    for (const stage of SDLC_RUNDEF.stages) {
      expect(Object.isFrozen(stage)).toBe(true);
    }
  });

  it("exports built-in RunDef ids in deterministic order", () => {
    expect(BUILTIN_RUNDEF_IDS).toEqual(["sdlc"]);
  });

  it("lists built-in RunDef ids in deterministic order", () => {
    expect(listBuiltinRunDefIds()).toEqual(["sdlc"]);
  });

  it("returns a defensive copy of built-in RunDef ids", () => {
    const firstList = listBuiltinRunDefIds();
    const secondList = listBuiltinRunDefIds();

    expect(firstList).toEqual(["sdlc"]);
    expect(secondList).toEqual(["sdlc"]);
    expect(firstList).not.toBe(secondList);
  });

  it("recognizes built-in RunDef ids", () => {
    expect(isBuiltinRunDefId("sdlc")).toBe(true);
    expect(isBuiltinRunDefId("custom")).toBe(false);
    expect(isBuiltinRunDefId("SDLC")).toBe(false);
  });

  it("resolves the built-in SDLC RunDef by id", () => {
    expect(resolveBuiltinRunDef("sdlc")).toBe(SDLC_RUNDEF);
    expect(resolveRunDef("sdlc")).toBe(SDLC_RUNDEF);
  });

  it.each(["", "custom", "SDLC", "sdlc-extra"])(
    "returns undefined for non-built-in id %j",
    (id) => {
      expect(resolveBuiltinRunDef(id)).toBeUndefined();
      expect(resolveRunDef(id)).toBeUndefined();
    },
  );

  it("does not require payload gates merely to resolve the built-in RunDef", () => {
    expect(resolveRunDef("sdlc")).toBe(SDLC_RUNDEF);
  });

  it("compiles the built-in SDLC RunDef when its gate functions are registered", () => {
    registerPayloadGate("e2e-verify", passGate);
    registerPayloadGate("code-review", passGate);

    const stages = compileRunDef(SDLC_RUNDEF);

    expect(stages.map((stage) => stage.id)).toEqual([
      "create-story",
      "e2e-plan",
      "dev-story",
      "e2e-verify",
      "code-review",
      "docs",
    ]);
    expect(stages.map((stage) => stage.timeoutSeconds)).toEqual([
      1800, 1800, 3600, 7200, 1800, 1800,
    ]);
    expect(stages[3]?.payloadGateName).toBe("e2e-verify");
    expect(stages[4]?.payloadGateName).toBe("code-review");
  });
});
