import { beforeEach, describe, expect, it } from "vitest";

import type { PayloadGate } from "./index.js";
import {
  clearPayloadGateRegistry,
  listPayloadGateNames,
  payloadGateRegistry,
  registerPayloadGate,
  resolvePayloadGate,
} from "./index.js";

describe("payload gate registry", () => {
  beforeEach(() => {
    clearPayloadGateRegistry();
  });

  it("registers and resolves a payload gate by name", () => {
    const gate: PayloadGate = (payload) => ({
      passed: payload["verdict"] === "pass",
      reason: "checked",
    });

    registerPayloadGate("e2e-verify", gate);

    expect(resolvePayloadGate("e2e-verify")).toBe(gate);
    expect(payloadGateRegistry.resolve("e2e-verify")).toBe(gate);
  });

  it("returns undefined for a valid but unknown gate name", () => {
    expect(resolvePayloadGate("code-review")).toBeUndefined();
  });

  it("allows idempotent registration of the same function", () => {
    const gate: PayloadGate = () => ({ passed: true });

    registerPayloadGate("code-review", gate);
    registerPayloadGate("code-review", gate);

    expect(resolvePayloadGate("code-review")).toBe(gate);
  });

  it("rejects duplicate registration with a different function", () => {
    const firstGate: PayloadGate = () => ({ passed: true });
    const secondGate: PayloadGate = () => ({ passed: false });

    registerPayloadGate("code-review", firstGate);

    expect(() => {
      registerPayloadGate("code-review", secondGate);
    }).toThrow(/already registered/u);
  });

  it("lists registered names in sorted deterministic order", () => {
    const gate: PayloadGate = () => ({ passed: true });

    registerPayloadGate("z-gate", gate);
    registerPayloadGate("a-gate", gate);

    expect(listPayloadGateNames()).toEqual(["a-gate", "z-gate"]);
  });

  it("returns a defensive copy of registered names", () => {
    const gate: PayloadGate = () => ({ passed: true });

    registerPayloadGate("a-gate", gate);

    const firstList = listPayloadGateNames();
    const secondList = listPayloadGateNames();

    expect(firstList).toEqual(["a-gate"]);
    expect(secondList).toEqual(["a-gate"]);
    expect(firstList).not.toBe(secondList);
  });

  it.each(["", " ", "E2E", "e2e_verify", "-bad", "bad-", "bad name"])(
    "rejects malformed gate name %j",
    (name) => {
      const gate: PayloadGate = () => ({ passed: true });

      expect(() => {
        registerPayloadGate(name, gate);
      }).toThrow(RangeError);
      expect(() => {
        resolvePayloadGate(name);
      }).toThrow(RangeError);
    },
  );

  it("clears the module-level registry", () => {
    const gate: PayloadGate = () => ({ passed: true });

    registerPayloadGate("e2e-verify", gate);
    clearPayloadGateRegistry();

    expect(resolvePayloadGate("e2e-verify")).toBeUndefined();
    expect(listPayloadGateNames()).toEqual([]);
  });
});
