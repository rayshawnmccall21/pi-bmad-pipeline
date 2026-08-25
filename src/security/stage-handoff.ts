import { redactValue, type RedactableValue } from "./redaction.js";

declare const stageHandoffBrand: unique symbol;

/** Normalized, redacted, UTF-8-bounded serialized stage context. */
export type StageHandoff = string & {
  readonly [stageHandoffBrand]: true;
};

/** Maximum UTF-8 size of a normalized stage handoff. */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- documented 32 KiB security cap.
const MAX_STAGE_HANDOFF_BYTES = 32 * 1024;

/**
 * Creates a normalized stage handoff from JSON-like payload data.
 *
 * @param value - Authenticated payload data to normalize.
 *
 * @returns The redacted compact JSON, or undefined when invalid or oversized.
 *
 * @example
 * ```ts
 * const handoff = createStageHandoff({ status: "passed" });
 * ```
 */
export function createStageHandoff(value: unknown): StageHandoff | undefined {
  try {
    if (!isRedactableValue(value, new WeakSet())) {
      return undefined;
    }

    const serialized = JSON.stringify(redactValue(value));
    if (Buffer.byteLength(serialized, "utf8") > MAX_STAGE_HANDOFF_BYTES) {
      return undefined;
    }

    // The brand records that this string passed the sole normalization boundary.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- nominal string constructor.
    return serialized as StageHandoff;
  } catch {
    return undefined;
  }
}

/**
 * Defensively parses and normalizes a loaded serialized handoff.
 *
 * @param serialized - Potential persisted handoff value.
 *
 * @returns A safe normalized handoff, or undefined when invalid or oversized.
 *
 * @example
 * ```ts
 * const handoff = sanitizeStageHandoff('{"status":"passed"}');
 * ```
 */
export function sanitizeStageHandoff(serialized: unknown): StageHandoff | undefined {
  if (typeof serialized !== "string") {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(serialized);
    return createStageHandoff(parsed);
  } catch {
    return undefined;
  }
}

const isRedactableValue = (value: unknown, ancestors: WeakSet<object>): value is RedactableValue =>
  isRedactablePrimitive(value) ||
  (isPlainContainerValue(value) && hasRedactableEntries(value, ancestors));

const isPlainContainerValue = (value: unknown): value is object =>
  typeof value === "object" && value !== null && isPlainContainer(value);

const hasRedactableEntries = (value: object, ancestors: WeakSet<object>): boolean => {
  if (ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  const entries: readonly unknown[] = Array.isArray(value) ? value : Object.values(value);
  const valid = entries.every((entry) => isRedactableValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
};

const isRedactablePrimitive = (value: unknown): value is null | string | number | boolean =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

const isPlainContainer = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return Array.isArray(value)
    ? prototype === Array.prototype
    : prototype === Object.prototype || prototype === null;
};
