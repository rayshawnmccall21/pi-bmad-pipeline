/**
 * Module-level payload gate registry for RunDef stage gate resolution.
 *
 * Provides a deterministic, in-process registry that maps gate names to
 * evaluation functions. The compile step resolves gate names from RunDef
 * stages into executable functions via this registry.
 *
 * @packageDocumentation
 */

import type { PayloadGate, PayloadGateRegistry } from "./types.js";

/** Regular expression validating payload gate names; rejects trailing hyphens. */
const GATE_NAME_PATTERN = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/u;

/** Module-level storage for registered payload gates. */
const registry = new Map<string, PayloadGate>();

/**
 * Registers a payload gate under the given name.
 *
 * Idempotent when the same function reference is re-registered for the same
 * name; rejects silently replacing an existing gate with a different function.
 *
 * @param name - Stable gate name declared by a RunDef stage.
 * @param gate - Gate function to evaluate child-process payloads.
 *
 * @throws When the gate name is blank or does not match the allowed pattern.
 * @throws When a different gate function is already registered for the name.
 *
 * @example
 * ```ts
 * registerPayloadGate("e2e-verify", payload => ({
 *   passed: payload["verdict"] === "pass",
 * }));
 * ```
 */
export function registerPayloadGate(name: string, gate: PayloadGate): void {
  if (!GATE_NAME_PATTERN.test(name)) {
    throw new RangeError(
      `Invalid payload gate name "${name}" in registerPayloadGate. Expected lowercase letters, digits, and hyphens, starting with a letter.`,
    );
  }
  const existing = registry.get(name);
  if (existing !== undefined && existing !== gate) {
    throw new Error(`Payload gate "${name}" is already registered with a different function.`);
  }
  registry.set(name, gate);
}

/**
 * Resolves a registered payload gate by name.
 *
 * @param name - Stable gate name declared by a RunDef stage.
 *
 * @returns The registered gate function, or undefined when no gate is registered.
 *
 * @throws When the gate name is blank or does not match the allowed pattern.
 *
 * @example
 * ```ts
 * const gate = resolvePayloadGate("code-review");
 * ```
 */
export function resolvePayloadGate(name: string): PayloadGate | undefined {
  if (!GATE_NAME_PATTERN.test(name)) {
    throw new RangeError(
      `Invalid payload gate name "${name}" in resolvePayloadGate. Expected lowercase letters, digits, and hyphens, starting with a letter.`,
    );
  }
  return registry.get(name);
}

/**
 * Lists all registered payload gate names in deterministic sorted order.
 *
 * @returns A new array containing every registered gate name, sorted alphabetically.
 *
 * @example
 * ```ts
 * const names = listPayloadGateNames();
 * ```
 */
export function listPayloadGateNames(): readonly string[] {
  return [...registry.keys()].sort();
}

/**
 * Removes every registered payload gate from the module-level registry.
 *
 * Intended for test isolation; production code should not call this.
 *
 * @example
 * ```ts
 * clearPayloadGateRegistry();
 * ```
 */
export function clearPayloadGateRegistry(): void {
  registry.clear();
}

/** Default payload gate registry implementing the PayloadGateRegistry interface. */
export const payloadGateRegistry: PayloadGateRegistry = {
  resolve: resolvePayloadGate,
};
