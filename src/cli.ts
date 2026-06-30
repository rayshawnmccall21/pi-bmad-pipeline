/**
 * CLI entry point for the bmad-pipeline command.
 *
 * @packageDocumentation
 */

import { PACKAGE_NAME, PACKAGE_VERSION } from "./meta.js";

/**
 * Prints the CLI version banner.
 *
 * @returns The version string.
 *
 * @example
 * Calling `versionBanner()` returns the string `pi-bmad-pipeline v0.1.0`.
 */
export function versionBanner(): string {
  return `${PACKAGE_NAME} v${PACKAGE_VERSION}`;
}
