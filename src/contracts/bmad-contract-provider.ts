/**
 * Workflow contract provider backed by the real `pi-bmad/contracts` surface.
 *
 * This adapter is the ONLY pipeline module that imports pi-bmad. It normalizes
 * the canonical validator result `{ valid, errors: [{ code, field, message }] }`
 * into the pipeline's {@link WorkflowContractProvider} result shape, and it
 * additionally enforces that the candidate envelope's `workflow` and
 * `returnType` identity fields match the expected contract, failing closed with
 * typed mismatch codes when they do not.
 *
 * @packageDocumentation
 */

import {
  RUNTIME_WORKFLOW_IDS,
  WORKFLOW_RESULT_CONTRACTS,
  validateHeadlessWorkflowOutput,
  type HeadlessWorkflowOutputValidationCode,
  type HeadlessWorkflowOutputValidationError,
  type HeadlessWorkflowOutputValidationResult as ContractValidationResult,
} from "pi-bmad/contracts";

import type {
  HeadlessWorkflowOutputValidationIssue,
  WorkflowContractProvider,
  WorkflowExpectedReturn,
} from "./workflow-contract-provider.js";

/** Typed codes for expected-contract identity mismatches detected by this adapter. */
export type BmadExpectedContractMismatchCode =
  "PIPELINE_EXPECTED_WORKFLOW_MISMATCH" | "PIPELINE_EXPECTED_RETURN_TYPE_MISMATCH";

/** Machine-readable issue codes: real pi-bmad envelope codes plus adapter mismatch codes. */
export type BmadHeadlessValidationIssueCode =
  HeadlessWorkflowOutputValidationCode | BmadExpectedContractMismatchCode;

/** One normalized validation issue carrying its stable machine-readable code. */
export interface BmadHeadlessOutputValidationIssue extends HeadlessWorkflowOutputValidationIssue {
  /** Stable machine-readable code identifying the failed check. */
  readonly code: BmadHeadlessValidationIssueCode;
}

/** Adapter validation result narrowing the provider result to code-carrying issues. */
export type BmadHeadlessOutputValidationResult =
  | {
      /** Discriminant: the candidate passed structure and identity checks. */
      readonly ok: true;

      /** The validated candidate envelope. */
      readonly value: unknown;
    }
  | {
      /** Discriminant: the candidate failed at least one check. */
      readonly ok: false;

      /** All normalized validation issues, each with a typed code. */
      readonly issues: readonly BmadHeadlessOutputValidationIssue[];
    };

/** Pi-bmad contract adapter dependencies, injectable for tests. */
export interface BmadWorkflowContractProviderDependencies {
  /** Resolves the expected return type id for a workflow. */
  readonly resolveExpectedReturnType: (workflow: string) => string;

  /** Real-shaped pi-bmad headless envelope validator. */
  readonly validateHeadlessWorkflowOutput: (
    candidate: unknown,
    options: { readonly rootDir?: string },
  ) => ContractValidationResult;
}

/** Options for constructing a {@link BmadWorkflowContractProvider}. */
export interface BmadWorkflowContractProviderOptions {
  /** Injectable dependencies; defaults to the real pi-bmad contract functions. */
  readonly dependencies?: BmadWorkflowContractProviderDependencies;

  /** Schema root directory forwarded to the pi-bmad payload validator. */
  readonly rootDir?: string;
}

/** Error code emitted by pi-bmad contract adapter failures. */
export type BmadWorkflowContractProviderErrorCode = "unknown-workflow" | "blank-return-type";

/** Error thrown when a workflow return contract cannot be resolved. */
export class BmadWorkflowContractProviderError extends Error {
  /** Stable machine-readable error code. */
  public readonly code: BmadWorkflowContractProviderErrorCode;

  /** Workflow id the failure relates to. */
  public readonly workflow: string;

  /**
   * Creates a contract adapter error.
   *
   * @param details - Failure code and the workflow it relates to.
   *
   * @example
   * ```ts
   * throw new BmadWorkflowContractProviderError({ code: "unknown-workflow", workflow: "nope" });
   * ```
   */
  public constructor(details: {
    readonly code: BmadWorkflowContractProviderErrorCode;
    readonly workflow: string;
  }) {
    super(buildProviderErrorMessage(details.code, details.workflow));
    this.name = "BmadWorkflowContractProviderError";
    this.code = details.code;
    this.workflow = details.workflow;
  }
}

/** Workflow contract provider backed by pi-bmad/contracts. */
export class BmadWorkflowContractProvider implements WorkflowContractProvider {
  private readonly dependencies: BmadWorkflowContractProviderDependencies;

  private readonly rootDir: string | undefined;

  /**
   * Creates a provider wired to pi-bmad/contracts by default.
   *
   * @param options - Injectable dependencies and optional schema root.
   */
  public constructor(options: BmadWorkflowContractProviderOptions = {}) {
    this.dependencies = options.dependencies ?? defaultDependencies;
    this.rootDir = options.rootDir;
  }

  /**
   * Resolves the expected return type id for a workflow.
   *
   * @param workflow - Workflow id to resolve.
   *
   * @returns The stable return type id declared by the workflow contract.
   *
   * @throws RangeError When the workflow id is blank.
   * @throws BmadWorkflowContractProviderError When no contract resolves or the
   * resolved return type is blank.
   *
   * @example
   * ```ts
   * provider.resolveExpectedReturnType("dev-story");
   * // "pi-bmad.workflow.dev-story.result.v1"
   * ```
   */
  public resolveExpectedReturnType(workflow: string): string {
    validateNonBlank(workflow, "workflow");
    const returnType = this.dependencies.resolveExpectedReturnType(workflow);
    if (returnType.trim().length === 0) {
      throw new BmadWorkflowContractProviderError({ code: "blank-return-type", workflow });
    }
    return returnType;
  }

  /**
   * Validates a candidate headless envelope against structure AND identity.
   *
   * The real pi-bmad validator gates envelope structure; this adapter then
   * verifies the candidate's `workflow` and `returnType` fields match the
   * expected contract so a structurally valid envelope from the wrong workflow
   * can never pass.
   *
   * @param candidate - JSON candidate emitted by a headless pi-bmad child.
   * @param expected - Expected workflow identity the envelope must match.
   *
   * @returns Frozen ok/issues result; issues carry typed machine-readable codes.
   *
   * @throws RangeError When the expected workflow or return type is blank.
   *
   * @example
   * ```ts
   * const result = provider.validateHeadlessOutput(candidate, {
   *   workflow: "dev-story",
   *   returnType: "pi-bmad.workflow.dev-story.result.v1",
   * });
   * if (!result.ok) {
   *   rejectStage(result.issues);
   * }
   * ```
   */
  public validateHeadlessOutput(
    candidate: unknown,
    expected: WorkflowExpectedReturn,
  ): BmadHeadlessOutputValidationResult {
    validateExpected(expected);
    const contractResult = this.dependencies.validateHeadlessWorkflowOutput(
      candidate,
      buildValidatorOptions(this.rootDir),
    );
    const mismatchIssues = expectedMismatchIssues(candidate, expected);
    if (contractResult.valid && mismatchIssues.length === 0) {
      return Object.freeze({ ok: true, value: candidate });
    }
    return failure([...contractResult.errors.map(issueFromContractError), ...mismatchIssues]);
  }
}

const resolveContractReturnType = (workflow: string): string => {
  const workflowId = RUNTIME_WORKFLOW_IDS.find((id) => id === workflow);
  if (workflowId === undefined) {
    throw new BmadWorkflowContractProviderError({ code: "unknown-workflow", workflow });
  }
  return WORKFLOW_RESULT_CONTRACTS[workflowId].typeId;
};

const defaultDependencies: BmadWorkflowContractProviderDependencies = Object.freeze({
  resolveExpectedReturnType: resolveContractReturnType,
  validateHeadlessWorkflowOutput: (
    candidate: unknown,
    options: { readonly rootDir?: string },
  ): ContractValidationResult => validateHeadlessWorkflowOutput(candidate, options),
});

const buildValidatorOptions = (rootDir: string | undefined): { readonly rootDir?: string } =>
  rootDir === undefined ? {} : { rootDir };

const expectedMismatchIssues = (
  candidate: unknown,
  expected: WorkflowExpectedReturn,
): readonly BmadHeadlessOutputValidationIssue[] => {
  if (!isRecord(candidate)) {
    return [];
  }
  return [
    ...identityIssue(candidate["workflow"], expected.workflow, "workflow"),
    ...identityIssue(candidate["returnType"], expected.returnType, "returnType"),
  ];
};

const identityIssue = (
  actual: unknown,
  expectedValue: string,
  path: "workflow" | "returnType",
): readonly BmadHeadlessOutputValidationIssue[] =>
  actual === expectedValue
    ? []
    : [
        freezeIssue(
          mismatchCodeByPath[path],
          path,
          `${path} must equal "${expectedValue}" but was ${describeValue(actual)}.`,
        ),
      ];

const describeValue = (value: unknown): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

const mismatchCodeByPath: Readonly<
  Record<"workflow" | "returnType", BmadExpectedContractMismatchCode>
> = Object.freeze({
  workflow: "PIPELINE_EXPECTED_WORKFLOW_MISMATCH",
  returnType: "PIPELINE_EXPECTED_RETURN_TYPE_MISMATCH",
});

const issueFromContractError = (
  error: HeadlessWorkflowOutputValidationError,
): BmadHeadlessOutputValidationIssue => freezeIssue(error.code, error.field, error.message);

const freezeIssue = (
  code: BmadHeadlessValidationIssueCode,
  path: string,
  message: string,
): BmadHeadlessOutputValidationIssue => Object.freeze({ code, path, message });

const failure = (
  issues: readonly BmadHeadlessOutputValidationIssue[],
): BmadHeadlessOutputValidationResult =>
  Object.freeze({ ok: false, issues: Object.freeze([...issues]) });

const validateExpected = (expected: WorkflowExpectedReturn): void => {
  validateNonBlank(expected.workflow, "expected.workflow");
  validateNonBlank(expected.returnType, "expected.returnType");
};

const validateNonBlank = (value: string, field: string): void => {
  if (value.trim().length === 0) {
    throw new RangeError(`${field} must not be blank.`);
  }
};

const buildProviderErrorMessage = (
  code: BmadWorkflowContractProviderErrorCode,
  workflow: string,
): string =>
  code === "unknown-workflow"
    ? `No workflow return contract found for "${workflow}".`
    : `Resolved return type for workflow "${workflow}" must not be blank.`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
