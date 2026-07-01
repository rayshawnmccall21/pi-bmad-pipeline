import { beforeEach, describe, expect, it } from "vitest";

import {
  SDLC_RUNDEF,
  clearPayloadGateRegistry,
  compileRunDef,
  resolvePayloadGate,
} from "../rundef/index.js";
import {
  CODE_REVIEW_PAYLOAD_GATE_NAME,
  E2E_VERIFY_PAYLOAD_GATE_NAME,
  codeReviewPayloadGate,
  e2eVerifyPayloadGate,
  registerBmadPayloadGates,
} from "./index.js";

beforeEach(() => {
  clearPayloadGateRegistry();
});

describe("built-in BMAD payload gates", () => {
  it("exports gate names exactly", () => {
    expect(E2E_VERIFY_PAYLOAD_GATE_NAME).toBe("e2e-verify");
    expect(CODE_REVIEW_PAYLOAD_GATE_NAME).toBe("code-review");
  });

  it.each([{ passed: true }, { verdict: "passed" }, { status: "success" }])(
    "passes e2e payload %j",
    (payload) => {
      expect(e2eVerifyPayloadGate(payload)).toMatchObject({
        passed: true,
        reason: "E2E verification passed.",
      });
    },
  );

  it.each([{ passed: false }, { verdict: "failed" }, { status: "blocked" }])(
    "fails e2e payload %j",
    (payload) => {
      expect(e2eVerifyPayloadGate(payload)).toMatchObject({
        passed: false,
        reason: "E2E verification failed.",
      });
    },
  );

  it.each([{}, { status: "maybe" }])("fails e2e closed for unknown payload %j", (payload) => {
    expect(e2eVerifyPayloadGate(payload)).toMatchObject({
      passed: false,
      reason: "E2E verification payload did not include a recognized pass/fail verdict.",
    });
  });

  it.each([{ approved: true }, { verdict: "approved" }, { status: "clean" }])(
    "passes code-review payload %j",
    (payload) => {
      expect(codeReviewPayloadGate(payload)).toMatchObject({
        passed: true,
        reason: "Code review passed.",
      });
    },
  );

  it.each([{ approved: false }, { verdict: "changes-requested" }, { status: "rejected" }])(
    "fails code-review payload %j",
    (payload) => {
      expect(codeReviewPayloadGate(payload)).toMatchObject({
        passed: false,
        reason: "Code review failed.",
      });
    },
  );

  it.each([{}, { status: "maybe" }])(
    "fails code-review closed for unknown payload %j",
    (payload) => {
      expect(codeReviewPayloadGate(payload)).toMatchObject({
        passed: false,
        reason: "Code review payload did not include a recognized pass/fail verdict.",
      });
    },
  );

  it.each([
    [{ passed: false, findings: ["a", "b"] }, ["a", "b"]],
    [{ passed: false, failures: ["a"] }, ["a"]],
    [{ passed: false, issues: ["a", 1, null, "b"] }, ["a", "b"]],
  ])("extracts findings from %j", (payload, expected) => {
    expect(e2eVerifyPayloadGate(payload).findings).toEqual(expected);
  });

  it("freezes results and findings arrays", () => {
    const result = codeReviewPayloadGate({ approved: false, findings: ["a"] });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.findings)).toBe(true);
  });

  it("does not mutate payload input", () => {
    const payload = { passed: false, findings: ["a"] };
    const before = JSON.stringify(payload);

    e2eVerifyPayloadGate(payload);

    expect(JSON.stringify(payload)).toBe(before);
  });

  it("registers both gate names in the module-level registry", () => {
    const result = registerBmadPayloadGates();

    expect(result.registered).toEqual(["e2e-verify", "code-review"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.registered)).toBe(true);
    expect(resolvePayloadGate("e2e-verify")).toBe(e2eVerifyPayloadGate);
    expect(resolvePayloadGate("code-review")).toBe(codeReviewPayloadGate);
  });

  it("registers idempotently", () => {
    registerBmadPayloadGates();
    registerBmadPayloadGates();

    expect(resolvePayloadGate("e2e-verify")).toBe(e2eVerifyPayloadGate);
    expect(resolvePayloadGate("code-review")).toBe(codeReviewPayloadGate);
  });

  it("allows the built-in SDLC RunDef to compile after registration", () => {
    registerBmadPayloadGates();

    const stages = compileRunDef(SDLC_RUNDEF);

    expect(stages[3]?.payloadGateName).toBe("e2e-verify");
    expect(stages[3]?.payloadGate).toBe(e2eVerifyPayloadGate);
    expect(stages[4]?.payloadGateName).toBe("code-review");
    expect(stages[4]?.payloadGate).toBe(codeReviewPayloadGate);
  });
});
