/** Public security subsystem exports. */

export {
  HARNESS_EVIDENCE_FILE_NAME,
  HARNESS_EVIDENCE_RELATIVE_DIR,
  HarnessEvidenceStoreError,
  getHarnessEvidenceDir,
  getHarnessEvidencePath,
  getHarnessEvidenceStoryDir,
  loadHarnessEvidence,
  saveHarnessEvidence,
} from "./harness-evidence-store.js";

export {
  DEFAULT_HARNESS_EVIDENCE_COMMANDS,
  DEFAULT_HARNESS_EVIDENCE_TIMEOUT_MS,
  MAX_HARNESS_EVIDENCE_OUTPUT_CHARS,
  runHarnessEvidence,
  runHarnessEvidenceCommand,
} from "./harness-evidence.js";

export { REDACTION_PLACEHOLDER, redactError, redactText, redactValue } from "./redaction.js";

export type {
  HarnessEvidenceStoreErrorCode,
  HarnessEvidenceStoreErrorDetails,
  LoadHarnessEvidenceRequest,
  SaveHarnessEvidenceRequest,
} from "./harness-evidence-store.js";

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
