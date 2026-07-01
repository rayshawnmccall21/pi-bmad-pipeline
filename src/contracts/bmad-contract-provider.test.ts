import { describe, expect, it } from "vitest";

import {
  BmadWorkflowContractProvider,
  BmadWorkflowContractProviderError,
  bmadWorkflowContractProvider,
} from "./index.js";

import type { BmadWorkflowContractProviderDependencies, WorkflowExpectedReturn } from "./index.js";

const expected = (): WorkflowExpectedReturn => ({
  workflow: "dev-story",
  returnType: "dev-result",
});

const provider = (
  validateResult: unknown,
  returnType = "dev-result",
): BmadWorkflowContractProvider =>
  new BmadWorkflowContractProvider(dependencies(validateResult, returnType));

const dependencies = (
  validateResult: unknown,
  returnType = "dev-result",
): BmadWorkflowContractProviderDependencies => ({
  resolveExpectedReturnType: () => returnType,
  validateHeadlessWorkflowOutput: () => validateResult,
});

describe("BmadWorkflowContractProvider", () => {
  it("resolves expected return type via injected dependency", () => {
    expect(
      provider({ ok: true, value: null }, "custom-result").resolveExpectedReturnType("dev-story"),
    ).toBe("custom-result");
  });

  it("rejects blank workflow name", () => {
    expect(() => provider({ ok: true, value: null }).resolveExpectedReturnType(" ")).toThrow(
      new RangeError("workflow must not be blank."),
    );
  });

  it("throws provider error if resolved return type is blank", () => {
    expect(() =>
      provider({ ok: true, value: null }, " ").resolveExpectedReturnType("dev-story"),
    ).toThrow(BmadWorkflowContractProviderError);
  });

  it("validates ok true results", () => {
    const value = { ok: true };

    expect(provider({ ok: true, value }).validateHeadlessOutput({}, expected())).toEqual({
      ok: true,
      value,
    });
  });

  it("validates valid true results", () => {
    const value = { valid: true };

    expect(provider({ valid: true, value }).validateHeadlessOutput({}, expected())).toEqual({
      ok: true,
      value,
    });
  });

  it("validates success true data results", () => {
    const data = { success: true };

    expect(provider({ success: true, data }).validateHeadlessOutput({}, expected())).toEqual({
      ok: true,
      value: data,
    });
  });

  it("normalizes ok false issues", () => {
    expect(
      provider({ ok: false, issues: [{ path: "/x", message: "bad" }] }).validateHeadlessOutput(
        {},
        expected(),
      ),
    ).toEqual({
      ok: false,
      issues: [{ path: "/x", message: "bad" }],
    });
  });

  it("normalizes valid false issues", () => {
    expect(
      provider({ valid: false, issues: [{ path: "/x", message: "bad" }] }).validateHeadlessOutput(
        {},
        expected(),
      ),
    ).toEqual({
      ok: false,
      issues: [{ path: "/x", message: "bad" }],
    });
  });

  it("normalizes success false errors", () => {
    expect(
      provider({ success: false, errors: [{ path: "/x", message: "bad" }] }).validateHeadlessOutput(
        {},
        expected(),
      ),
    ).toEqual({
      ok: false,
      issues: [{ path: "/x", message: "bad" }],
    });
  });

  it("maps instancePath to path", () => {
    const result = provider({
      ok: false,
      issues: [{ instancePath: "/payload", message: "bad" }],
    }).validateHeadlessOutput({}, expected());

    expect(result).toEqual({ ok: false, issues: [{ path: "/payload", message: "bad" }] });
  });

  it("maps string issues to root-path issues", () => {
    expect(provider({ ok: false, issues: ["bad"] }).validateHeadlessOutput({}, expected())).toEqual(
      {
        ok: false,
        issues: [{ path: "", message: "bad" }],
      },
    );
  });

  it("maps unknown issue shapes", () => {
    expect(
      provider({ ok: false, issues: [{ nope: true }] }).validateHeadlessOutput({}, expected()),
    ).toEqual({
      ok: false,
      issues: [{ path: "", message: "Unknown validation issue." }],
    });
  });

  it("rejects blank expected workflow", () => {
    expect(() =>
      provider({ ok: true, value: null }).validateHeadlessOutput(
        {},
        { ...expected(), workflow: " " },
      ),
    ).toThrow(new RangeError("expected.workflow must not be blank."));
  });

  it("rejects blank expected returnType", () => {
    expect(() =>
      provider({ ok: true, value: null }).validateHeadlessOutput(
        {},
        { ...expected(), returnType: " " },
      ),
    ).toThrow(new RangeError("expected.returnType must not be blank."));
  });

  it("throws provider error on unsupported dependency result", () => {
    expect(() => provider({ maybe: true }).validateHeadlessOutput({}, expected())).toThrow(
      BmadWorkflowContractProviderError,
    );
  });

  it("propagates dependency exceptions", () => {
    const thrown = new Error("boom");
    const throwingProvider = new BmadWorkflowContractProvider({
      resolveExpectedReturnType: () => "dev-result",
      validateHeadlessWorkflowOutput: () => {
        throw thrown;
      },
    });

    expect(() => throwingProvider.validateHeadlessOutput({}, expected())).toThrow(thrown);
  });

  it("freezes failed result and issues", () => {
    const result = provider({ ok: false, issues: ["bad"] }).validateHeadlessOutput({}, expected());

    expect(Object.isFrozen(result)).toBe(true);
    if (!result.ok) {
      expect(Object.isFrozen(result.issues)).toBe(true);
      expect(Object.isFrozen(result.issues[0])).toBe(true);
    }
  });

  it("freezes successful result object without deep-freezing value", () => {
    const value = { nested: true };
    const result = provider({ ok: true, value }).validateHeadlessOutput({}, expected());

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(value)).toBe(false);
  });

  it("does not mutate candidate or expected input", () => {
    const candidate = { output: true };
    const expectedReturn = expected();
    const before = JSON.stringify({ candidate, expectedReturn });

    provider({ ok: true, value: candidate }).validateHeadlessOutput(candidate, expectedReturn);

    expect(JSON.stringify({ candidate, expectedReturn })).toBe(before);
  });

  it("exports default provider with interface methods", () => {
    expect(typeof bmadWorkflowContractProvider.resolveExpectedReturnType).toBe("function");
    expect(typeof bmadWorkflowContractProvider.validateHeadlessOutput).toBe("function");
  });
});
