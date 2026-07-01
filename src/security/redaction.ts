/** Replacement marker for redacted credential material. */
export const REDACTION_PLACEHOLDER = "[REDACTED]" as const;

/** Credential pattern names reported by redaction. */
export type CredentialPatternName =
  | "bearer-token"
  | "openai-api-key"
  | "anthropic-api-key"
  | "google-api-key"
  | "github-token"
  | "aws-access-key-id"
  | "aws-secret-access-key";

/** Count of matches for one credential pattern. */
export interface RedactionMatchSummary {
  /** Credential pattern name. */
  readonly name: CredentialPatternName;

  /** Number of matches redacted. */
  readonly count: number;
}

/** Text redaction result. */
export interface RedactionResult {
  /** Sanitized text. */
  readonly value: string;

  /** True when at least one credential-like substring was replaced. */
  readonly redacted: boolean;

  /** Match counts in deterministic pattern order. */
  readonly matches: readonly RedactionMatchSummary[];
}

/** JSON-like value accepted by deep redaction. */
export type RedactableValue =
  null | string | number | boolean | readonly RedactableValue[] | RedactableObject;

interface RedactableObject {
  readonly [key: string]: RedactableValue;
}

interface ReplaceResult {
  readonly value: string;
  readonly count: number;
}

interface CredentialPattern {
  readonly name: CredentialPatternName;
  readonly replace: (input: string) => ReplaceResult;
}

/**
 * Redacts credential-looking substrings from text.
 *
 * @param input - Text to sanitize.
 *
 * @returns Frozen redaction result.
 *
 * @example
 * ```ts
 * const result = redactText("Authorization: Bearer fake-token-value-123456");
 * ```
 */
export function redactText(input: string): RedactionResult {
  let value = input;
  const matches: RedactionMatchSummary[] = [];
  for (const pattern of credentialPatterns) {
    const result = pattern.replace(value);
    value = result.value;
    if (result.count > 0) {
      matches.push(Object.freeze({ name: pattern.name, count: result.count }));
    }
  }
  return Object.freeze({ value, redacted: matches.length > 0, matches: Object.freeze(matches) });
}

/**
 * Redacts credential-looking substrings from an Error message and stack.
 *
 * @param error - Error to sanitize.
 *
 * @returns Frozen redaction result.
 *
 * @example
 * ```ts
 * const result = redactError(new Error("failed with sk-fakefakefakefakefake"));
 * ```
 */
export function redactError(error: Error): RedactionResult {
  const text =
    error.stack === undefined
      ? `${error.name}: ${error.message}`
      : `${error.name}: ${error.message}\n${error.stack}`;
  return redactText(text);
}

/**
 * Deep-redacts string leaves inside a JSON-like value.
 *
 * @param value - JSON-like value to sanitize.
 *
 * @returns Deep-frozen sanitized value.
 *
 * @example
 * ```ts
 * const sanitized = redactValue({ token: "Bearer fake-token-value-123456" });
 * ```
 */
export function redactValue(value: RedactableValue): RedactableValue {
  if (typeof value === "string") {
    return redactText(value).value;
  }
  if (isRedactableArray(value)) {
    return Object.freeze(value.map((item) => redactValue(item)));
  }
  if (isRedactableObject(value)) {
    return redactObject(value);
  }
  return value;
}

const redactObject = (value: RedactableObject): RedactableValue => {
  const redacted: Record<string, RedactableValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = redactValue(entry);
  }
  return Object.freeze(redacted);
};

const isRedactableArray = (value: RedactableValue): value is readonly RedactableValue[] =>
  Array.isArray(value);

const isRedactableObject = (value: RedactableValue): value is RedactableObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const simplePattern = (name: CredentialPatternName, regex: RegExp): CredentialPattern => ({
  name,
  replace(input) {
    return replaceAll(input, regex);
  },
});

const multiPattern = (
  name: CredentialPatternName,
  regexes: readonly RegExp[],
): CredentialPattern => ({
  name,
  replace(input) {
    return regexes.reduce(
      (current, regex) => {
        const next = replaceAll(current.value, regex);
        return { value: next.value, count: current.count + next.count };
      },
      { value: input, count: 0 },
    );
  },
});

const awsSecretPattern = (): CredentialPattern => ({
  name: "aws-secret-access-key",
  replace(input) {
    return replaceAll(
      input,
      /((?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key|awsSecretAccessKey)["'\s:=]+)[A-Za-z0-9/+=]{40}/gu,
      (_match, prefix: string) => `${prefix}${REDACTION_PLACEHOLDER}`,
    );
  },
});

const replaceAll = (
  input: string,
  regex: RegExp,
  replacer: string | ((match: string, prefix: string) => string) = REDACTION_PLACEHOLDER,
): ReplaceResult => {
  let count = 0;
  regex.lastIndex = 0;
  const value = input.replace(regex, (...args: readonly unknown[]) => {
    count += 1;
    return typeof replacer === "string" ? replacer : replacer(String(args[0]), String(args[1]));
  });
  return { value, count };
};

const credentialPatterns: readonly CredentialPattern[] = Object.freeze([
  simplePattern("bearer-token", /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gu),
  simplePattern("openai-api-key", /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/gu),
  simplePattern("anthropic-api-key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/gu),
  simplePattern("google-api-key", /\bAIza[0-9A-Za-z_-]{25,}\b/gu),
  multiPattern("github-token", [
    /\bgh[opusra]_[A-Za-z0-9_]{30,}\b/gu,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  ]),
  simplePattern("aws-access-key-id", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu),
  awsSecretPattern(),
]);
