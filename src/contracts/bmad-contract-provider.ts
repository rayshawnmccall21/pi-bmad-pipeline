/* eslint-disable jsdoc/require-jsdoc -- public contract mirrors the task spec. */

import { WORKFLOW_RESULT_CONTRACTS, validateHeadlessWorkflowOutput } from "pi-bmad/contracts";

import type {
  HeadlessWorkflowOutputValidationIssue,
  HeadlessWorkflowOutputValidationResult,
  WorkflowContractProvider,
  WorkflowExpectedReturn,
} from "./workflow-contract-provider.js";

/** Pi-bmad contract adapter dependencies, injectable for tests. */
export interface BmadWorkflowContractProviderDependencies {
  readonly resolveExpectedReturnType: (workflow: string) => string;
  readonly validateHeadlessWorkflowOutput: (
    candidate: unknown,
    expected: WorkflowExpectedReturn,
  ) => unknown;
}

/** Error thrown when pi-bmad contract APIs return an unsupported shape. */
export class BmadWorkflowContractProviderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BmadWorkflowContractProviderError";
  }
}

/** Workflow contract provider backed by pi-bmad/contracts. */
export class BmadWorkflowContractProvider implements WorkflowContractProvider {
  private readonly dependencies: BmadWorkflowContractProviderDependencies;

  public constructor(dependencies: BmadWorkflowContractProviderDependencies = defaultDependencies) {
    this.dependencies = dependencies;
  }

  public resolveExpectedReturnType(workflow: string): string {
    validateNonBlank(workflow, "workflow");
    const returnType = this.dependencies.resolveExpectedReturnType(workflow);
    if (returnType.trim().length === 0) {
      throw new BmadWorkflowContractProviderError(
        "Resolved workflow return type must not be blank.",
      );
    }
    return returnType;
  }

  public validateHeadlessOutput(
    candidate: unknown,
    expected: WorkflowExpectedReturn,
  ): HeadlessWorkflowOutputValidationResult {
    validateExpected(expected);
    return normalizeValidationResult(
      this.dependencies.validateHeadlessWorkflowOutput(candidate, expected),
    );
  }
}

const defaultDependencies: BmadWorkflowContractProviderDependencies = Object.freeze({
  resolveExpectedReturnType: (workflow: string): string => {
    const workflowContracts: unknown = WORKFLOW_RESULT_CONTRACTS;
    const returnType = readReturnType(workflowContracts, workflow);
    if (typeof returnType !== "string") {
      throw new BmadWorkflowContractProviderError(
        `No workflow return contract found for ${workflow}.`,
      );
    }
    return returnType;
  },
  validateHeadlessWorkflowOutput: (candidate: unknown): unknown =>
    validateHeadlessWorkflowOutput(candidate),
});

/** Default singleton contract provider. */
export const bmadWorkflowContractProvider: WorkflowContractProvider =
  new BmadWorkflowContractProvider();

const readReturnType = (contracts: unknown, workflow: string): unknown => {
  if (!isRecord(contracts)) {
    return undefined;
  }
  const contract = contracts[workflow];
  return isRecord(contract) ? contract["typeId"] : undefined;
};

const normalizeValidationResult = (value: unknown): HeadlessWorkflowOutputValidationResult => {
  if (!isRecord(value)) {
    throw unsupportedResult();
  }
  return normalizeSuccess(value) ?? normalizeFailure(value);
};

const successShapes = Object.freeze([
  { flag: "ok", value: "value" },
  { flag: "valid", value: "value" },
  { flag: "success", value: "data" },
]);

const normalizeSuccess = (
  value: Record<string, unknown>,
): HeadlessWorkflowOutputValidationResult | undefined => {
  const shape = successShapes.find(
    (candidate) => value[candidate.flag] === true && candidate.value in value,
  );
  return shape === undefined ? undefined : success(value[shape.value]);
};

const normalizeFailure = (
  value: Record<string, unknown>,
): HeadlessWorkflowOutputValidationResult => {
  if (value["ok"] === false && Array.isArray(value["issues"])) {
    return failure(value["issues"]);
  }
  if (value["valid"] === false && Array.isArray(value["issues"])) {
    return failure(value["issues"]);
  }
  if (value["success"] === false && Array.isArray(value["errors"])) {
    return failure(value["errors"]);
  }
  throw unsupportedResult();
};

const success = (value: unknown): HeadlessWorkflowOutputValidationResult =>
  Object.freeze({ ok: true, value });

const failure = (issues: readonly unknown[]): HeadlessWorkflowOutputValidationResult =>
  Object.freeze({ ok: false, issues: Object.freeze(issues.map(normalizeIssue)) });

const normalizeIssue = (issue: unknown): HeadlessWorkflowOutputValidationIssue => {
  if (typeof issue === "string") {
    return freezeIssue("", issue);
  }
  if (!isRecord(issue)) {
    return unknownIssue();
  }
  return issueFromRecord(issue);
};

const issueFromRecord = (issue: Record<string, unknown>): HeadlessWorkflowOutputValidationIssue => {
  if (typeof issue["path"] === "string" && typeof issue["message"] === "string") {
    return freezeIssue(issue["path"], issue["message"]);
  }
  if (typeof issue["instancePath"] === "string" && typeof issue["message"] === "string") {
    return freezeIssue(issue["instancePath"], issue["message"]);
  }
  return unknownIssue();
};

const freezeIssue = (path: string, message: string): HeadlessWorkflowOutputValidationIssue =>
  Object.freeze({ path, message });

const unknownIssue = (): HeadlessWorkflowOutputValidationIssue =>
  freezeIssue("", "Unknown validation issue.");

const validateExpected = (expected: WorkflowExpectedReturn): void => {
  validateNonBlank(expected.workflow, "expected.workflow");
  validateNonBlank(expected.returnType, "expected.returnType");
};

const validateNonBlank = (value: string, field: string): void => {
  if (value.trim().length === 0) {
    throw new RangeError(`${field} must not be blank.`);
  }
};

const unsupportedResult = (): BmadWorkflowContractProviderError =>
  new BmadWorkflowContractProviderError("Unsupported headless workflow output validation result.");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
