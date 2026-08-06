import { createHash } from "node:crypto";

import type { RunDef } from "./types.js";

/**
 * Computes the stable content identity of a validated RunDef.
 *
 * @param runDef - Validated discovered RunDef.
 *
 * @returns A lowercase SHA-256 digest of canonical RunDef JSON.
 *
 * @example
 * ```ts
 * computeRunDefDigest({ id: "one", stages: [] });
 * ```
 */
export function computeRunDefDigest(runDef: RunDef): string {
  return createHash("sha256").update(canonicalJson(runDef)).digest("hex");
}

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalValue(value));

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, childValue]) => [key, canonicalValue(childValue)]),
  );
};
