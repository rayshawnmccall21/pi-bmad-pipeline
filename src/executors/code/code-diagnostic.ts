import { REDACTION_PLACEHOLDER, redactText } from "../../security/redaction.js";

/** Maximum retained failure diagnostic length in characters. */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- fixed security boundary.
export const MAX_CODE_DIAGNOSTIC_CHARS = 16_384 as const;

// Private overlap lets credential recognizers see tokens crossing the public cap.
const DIAGNOSTIC_REDACTION_LOOKAHEAD_CHARS = 128;

/** Independently decoded child streams feeding one diagnostic value. */
export interface DiagnosticCapture {
  /** Appends one stdout chunk. */
  readonly pushStdout: (chunk: Uint8Array | string) => void;
  /** Appends one stderr chunk. */
  readonly pushStderr: (chunk: Uint8Array | string) => void;
  /** Finalizes, redacts, and caps the combined diagnostic. */
  readonly value: () => string;
}

/**
 * Creates independently decoded streams feeding one bounded, redacted diagnostic.
 *
 * @returns Diagnostic capture for one local child.
 */
export const createDiagnosticCapture = (): DiagnosticCapture => {
  const rawLimit = MAX_CODE_DIAGNOSTIC_CHARS + DIAGNOSTIC_REDACTION_LOOKAHEAD_CHARS;
  let captured = "";
  let finished = false;
  const append = (text: string): void => {
    captured += text.slice(0, Math.max(0, rawLimit - captured.length));
  };
  const createPush =
    (decoder: TextDecoder) =>
    (chunk: Uint8Array | string): void => {
      if (!finished) {
        append(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
      }
    };
  const stdoutDecoder = new TextDecoder("utf-8");
  const stderrDecoder = new TextDecoder("utf-8");
  return {
    pushStdout: createPush(stdoutDecoder),
    pushStderr: createPush(stderrDecoder),
    value() {
      if (!finished) {
        append(stdoutDecoder.decode());
        append(stderrDecoder.decode());
        finished = true;
      }
      return capRedactedDiagnostic(redactText(captured).value);
    },
  };
};

const capRedactedDiagnostic = (redacted: string): string => {
  const placeholderStart = redacted.lastIndexOf(
    REDACTION_PLACEHOLDER,
    MAX_CODE_DIAGNOSTIC_CHARS - 1,
  );
  if (
    placeholderStart >= 0 &&
    placeholderStart + REDACTION_PLACEHOLDER.length > MAX_CODE_DIAGNOSTIC_CHARS
  ) {
    return `${redacted.slice(
      0,
      MAX_CODE_DIAGNOSTIC_CHARS - REDACTION_PLACEHOLDER.length,
    )}${REDACTION_PLACEHOLDER}`;
  }
  return redacted.slice(0, MAX_CODE_DIAGNOSTIC_CHARS);
};
