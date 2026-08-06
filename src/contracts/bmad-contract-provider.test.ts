import { HEADLESS_WORKFLOW_SCHEMA_VERSION } from "pi-bmad/contracts";
import { describe, expect, it, vi } from "vitest";

import { BmadWorkflowContractProvider, BmadWorkflowContractProviderError } from "./index.js";

import type {
  HeadlessWorkflowOutputValidationResult as ContractValidationResult,
  HeadlessWorkflowOutputValidationError,
} from "pi-bmad/contracts";
import type { BmadWorkflowContractProviderDependencies, WorkflowExpectedReturn } from "./index.js";

const DEV_STORY_RETURN_TYPE = "pi-bmad.workflow.dev-story.result.v1";

const expected = (): WorkflowExpectedReturn => ({
  workflow: "dev-story",
  returnType: DEV_STORY_RETURN_TYPE,
});

const matchingCandidate = (): Record<string, unknown> => ({
  workflow: "dev-story",
  returnType: DEV_STORY_RETURN_TYPE,
});

const passingValidation = (): ContractValidationResult => ({ valid: true, errors: [] });

const statusError = (): HeadlessWorkflowOutputValidationError => ({
  code: "HEADLESS_OUTPUT_STATUS_INVALID",
  field: "status",
  message: 'status must be "success", "partial", or "failed".',
});

const dependencies = (
  validationResult: ContractValidationResult,
  returnType = DEV_STORY_RETURN_TYPE,
): BmadWorkflowContractProviderDependencies => ({
  resolveExpectedReturnType: () => returnType,
  validateHeadlessWorkflowOutput: () => validationResult,
});

const provider = (
  validationResult: ContractValidationResult,
  returnType = DEV_STORY_RETURN_TYPE,
): BmadWorkflowContractProvider =>
  new BmadWorkflowContractProvider({ dependencies: dependencies(validationResult, returnType) });

const failedDevStoryEnvelope = (): Record<string, unknown> => ({
  schemaVersion: HEADLESS_WORKFLOW_SCHEMA_VERSION,
  workflow: "dev-story",
  returnType: DEV_STORY_RETURN_TYPE,
  status: "failed",
  exitCode: 1,
  completedSteps: ["load-story"],
  failedSteps: [{ step: "implement", reason: "tests failed" }],
  artifacts: {},
  payload: null,
  emittedAt: "2026-08-05T00:00:00.000Z",
  durationMs: 1200,
});

describe("BmadWorkflowContractProvider.resolveExpectedReturnType", () => {
  it("resolves expected return type via injected dependency", () => {
    expect(
      provider(passingValidation(), "custom-result").resolveExpectedReturnType("dev-story"),
    ).toBe("custom-result");
  });

  it("rejects blank workflow name", () => {
    expect(() => provider(passingValidation()).resolveExpectedReturnType(" ")).toThrow(
      new RangeError("workflow must not be blank."),
    );
  });

  it("throws blank-return-type when dependency resolves blank", () => {
    expect.assertions(2);
    try {
      provider(passingValidation(), " ").resolveExpectedReturnType("dev-story");
    } catch (error) {
      expect(error).toBeInstanceOf(BmadWorkflowContractProviderError);
      expect((error as BmadWorkflowContractProviderError).code).toBe("blank-return-type");
    }
  });

  it("resolves the real dev-story return type via default wiring", () => {
    expect(new BmadWorkflowContractProvider().resolveExpectedReturnType("dev-story")).toBe(
      DEV_STORY_RETURN_TYPE,
    );
  });

  it("throws unknown-workflow via default wiring for unknown workflows", () => {
    expect.assertions(3);
    try {
      new BmadWorkflowContractProvider().resolveExpectedReturnType("not-a-workflow");
    } catch (error) {
      expect(error).toBeInstanceOf(BmadWorkflowContractProviderError);
      expect((error as BmadWorkflowContractProviderError).code).toBe("unknown-workflow");
      expect((error as BmadWorkflowContractProviderError).workflow).toBe("not-a-workflow");
    }
  });
});

describe("BmadWorkflowContractProvider.validateHeadlessOutput", () => {
  it("returns ok with the candidate when structure and identity pass", () => {
    const candidate = matchingCandidate();

    const result = provider(passingValidation()).validateHeadlessOutput(candidate, expected());

    expect(result).toEqual({ ok: true, value: candidate });
    if (result.ok) {
      expect(result.value).toBe(candidate);
    }
  });

  it("normalizes real contract errors into code-carrying issues", () => {
    const result = provider({ valid: false, errors: [statusError()] }).validateHeadlessOutput(
      matchingCandidate(),
      expected(),
    );

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "HEADLESS_OUTPUT_STATUS_INVALID",
          path: "status",
          message: 'status must be "success", "partial", or "failed".',
        },
      ],
    });
  });

  it("fails closed on workflow mismatch even when structurally valid", () => {
    const candidate = { ...matchingCandidate(), workflow: "code-review" };

    const result = provider(passingValidation()).validateHeadlessOutput(candidate, expected());

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "PIPELINE_EXPECTED_WORKFLOW_MISMATCH",
          path: "workflow",
          message: 'workflow must equal "dev-story" but was "code-review".',
        },
      ],
    });
  });

  it("fails closed on returnType mismatch even when structurally valid", () => {
    const candidate = { ...matchingCandidate(), returnType: undefined };

    const result = provider(passingValidation()).validateHeadlessOutput(candidate, expected());

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "PIPELINE_EXPECTED_RETURN_TYPE_MISMATCH",
          path: "returnType",
          message: `returnType must equal "${DEV_STORY_RETURN_TYPE}" but was undefined.`,
        },
      ],
    });
  });

  it("merges structural errors with identity mismatch issues", () => {
    const candidate = { ...matchingCandidate(), workflow: "code-review" };

    const result = provider({ valid: false, errors: [statusError()] }).validateHeadlessOutput(
      candidate,
      expected(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual([
        "HEADLESS_OUTPUT_STATUS_INVALID",
        "PIPELINE_EXPECTED_WORKFLOW_MISMATCH",
      ]);
    }
  });

  it("adds no identity issues for non-object candidates", () => {
    const notObject: HeadlessWorkflowOutputValidationError = {
      code: "HEADLESS_OUTPUT_NOT_OBJECT",
      field: "/",
      message: "Headless workflow output must be a JSON object.",
    };

    const result = provider({ valid: false, errors: [notObject] }).validateHeadlessOutput(
      42,
      expected(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual(["HEADLESS_OUTPUT_NOT_OBJECT"]);
    }
  });

  it("adds no identity issues for array candidates", () => {
    const result = provider({ valid: false, errors: [] }).validateHeadlessOutput([], expected());

    expect(result).toEqual({ ok: false, issues: [] });
  });

  it("fails closed when dependency reports invalid without errors", () => {
    const result = provider({ valid: false, errors: [] }).validateHeadlessOutput(
      matchingCandidate(),
      expected(),
    );

    expect(result).toEqual({ ok: false, issues: [] });
  });

  it("passes configured rootDir to the contract validator", () => {
    const validate = vi.fn((): ContractValidationResult => passingValidation());
    const contractProvider = new BmadWorkflowContractProvider({
      dependencies: {
        resolveExpectedReturnType: () => DEV_STORY_RETURN_TYPE,
        validateHeadlessWorkflowOutput: validate,
      },
      rootDir: "/schemas/root",
    });

    contractProvider.validateHeadlessOutput(matchingCandidate(), expected());

    expect(validate).toHaveBeenCalledWith(expect.anything(), { rootDir: "/schemas/root" });
  });

  it("omits rootDir from validator options when not configured", () => {
    const validate = vi.fn((): ContractValidationResult => passingValidation());
    const contractProvider = new BmadWorkflowContractProvider({
      dependencies: {
        resolveExpectedReturnType: () => DEV_STORY_RETURN_TYPE,
        validateHeadlessWorkflowOutput: validate,
      },
    });

    contractProvider.validateHeadlessOutput(matchingCandidate(), expected());

    expect(validate).toHaveBeenCalledWith(expect.anything(), {});
  });

  it("rejects blank expected workflow", () => {
    expect(() =>
      provider(passingValidation()).validateHeadlessOutput(matchingCandidate(), {
        ...expected(),
        workflow: " ",
      }),
    ).toThrow(new RangeError("expected.workflow must not be blank."));
  });

  it("rejects blank expected returnType", () => {
    expect(() =>
      provider(passingValidation()).validateHeadlessOutput(matchingCandidate(), {
        ...expected(),
        returnType: " ",
      }),
    ).toThrow(new RangeError("expected.returnType must not be blank."));
  });

  it("propagates dependency exceptions", () => {
    const thrown = new Error("boom");
    const throwingProvider = new BmadWorkflowContractProvider({
      dependencies: {
        resolveExpectedReturnType: () => DEV_STORY_RETURN_TYPE,
        validateHeadlessWorkflowOutput: () => {
          throw thrown;
        },
      },
    });

    expect(() => throwingProvider.validateHeadlessOutput(matchingCandidate(), expected())).toThrow(
      thrown,
    );
  });

  it("freezes failure result and issues", () => {
    const result = provider({ valid: false, errors: [statusError()] }).validateHeadlessOutput(
      matchingCandidate(),
      expected(),
    );

    expect(Object.isFrozen(result)).toBe(true);
    if (!result.ok) {
      expect(Object.isFrozen(result.issues)).toBe(true);
      expect(Object.isFrozen(result.issues[0])).toBe(true);
    }
  });

  it("freezes success result without deep-freezing the candidate", () => {
    const candidate = matchingCandidate();

    const result = provider(passingValidation()).validateHeadlessOutput(candidate, expected());

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(candidate)).toBe(false);
  });

  it("does not mutate candidate or expected input", () => {
    const candidate = failedDevStoryEnvelope();
    const expectedReturn = expected();
    const before = JSON.stringify({ candidate, expectedReturn });

    provider(passingValidation()).validateHeadlessOutput(candidate, expectedReturn);

    expect(JSON.stringify({ candidate, expectedReturn })).toBe(before);
  });
});

describe("BmadWorkflowContractProvider default wiring", () => {
  it("accepts a real-shaped failed dev-story envelope", () => {
    const envelope = failedDevStoryEnvelope();

    const result = new BmadWorkflowContractProvider().validateHeadlessOutput(envelope, expected());

    expect(result).toEqual({ ok: true, value: envelope });
  });

  it("accepts a real-shaped project workflow success envelope", () => {
    const envelope = {
      ...failedDevStoryEnvelope(),
      workflow: "my-project-flow",
      returnType: "my-project-flow.result.v1",
      status: "success",
      exitCode: 0,
      failedSteps: [],
      payload: { done: true },
    };

    const result = new BmadWorkflowContractProvider().validateHeadlessOutput(envelope, {
      workflow: "my-project-flow",
      returnType: "my-project-flow.result.v1",
    });

    expect(result).toEqual({ ok: true, value: envelope });
  });

  it("rejects a schema-version violation with the real contract code", () => {
    const envelope = { ...failedDevStoryEnvelope(), schemaVersion: "nope" };

    const result = new BmadWorkflowContractProvider().validateHeadlessOutput(envelope, expected());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        {
          code: "HEADLESS_OUTPUT_SCHEMA_VERSION_INVALID",
          path: "schemaVersion",
          message: `schemaVersion must be ${HEADLESS_WORKFLOW_SCHEMA_VERSION}.`,
        },
      ]);
    }
  });

  it("rejects identity mismatches against the expected contract", () => {
    const result = new BmadWorkflowContractProvider().validateHeadlessOutput(
      failedDevStoryEnvelope(),
      { workflow: "code-review", returnType: "pi-bmad.workflow.code-review.result.v1" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual([
        "PIPELINE_EXPECTED_WORKFLOW_MISMATCH",
        "PIPELINE_EXPECTED_RETURN_TYPE_MISMATCH",
      ]);
    }
  });
});
