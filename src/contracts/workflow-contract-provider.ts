/** Expected workflow return contract. */
export interface WorkflowExpectedReturn {
  /** Workflow name. */
  readonly workflow: string;

  /** Expected return type resolved from workflow metadata. */
  readonly returnType: string;
}

/** One contract validation issue. */
export interface HeadlessWorkflowOutputValidationIssue {
  /** JSON pointer or logical path for the issue. */
  readonly path: string;

  /** Human-readable validation message. */
  readonly message: string;
}

/** Result of validating one headless workflow output candidate. */
export type HeadlessWorkflowOutputValidationResult =
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
      readonly issues: readonly HeadlessWorkflowOutputValidationIssue[];
    };

/** Boundary used by the pipeline supervisor to validate child output. */
export interface WorkflowContractProvider {
  resolveExpectedReturnType(workflow: string): string;

  validateHeadlessOutput(
    candidate: unknown,
    expected: WorkflowExpectedReturn,
  ): HeadlessWorkflowOutputValidationResult;
}
