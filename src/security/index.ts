/** Public security subsystem exports. */

export {
  DEFAULT_HARNESS_EVIDENCE_COMMANDS,
  DEFAULT_HARNESS_EVIDENCE_TIMEOUT_MS,
  MAX_HARNESS_EVIDENCE_OUTPUT_CHARS,
  runHarnessEvidence,
  runHarnessEvidenceCommand,
} from "./harness-evidence.js";

export { REDACTION_PLACEHOLDER, redactError, redactText, redactValue } from "./redaction.js";

export type {
  HarnessEvidenceCommand,
  HarnessEvidenceCommandName,
  HarnessEvidenceCommandResult,
  HarnessEvidenceCommandStatus,
  HarnessEvidenceReport,
  HarnessEvidenceSpawn,
  RunHarnessEvidenceRequest,
} from "./harness-evidence.js";

export type {
  CredentialPatternName,
  RedactableValue,
  RedactionMatchSummary,
  RedactionResult,
} from "./redaction.js";
