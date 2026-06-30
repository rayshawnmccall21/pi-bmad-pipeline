/**
 * Quality guard — blocks edits to locked quality gate files.
 *
 * Prevents agents from modifying linter, prettier, CRAP, coverage,
 * compiler, knip, and CLAUDE.md configs. AGENTS.md is allowed since
 * it's project-specific.
 *
 * @packageDocumentation
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";

/** Files that must not be modified by agents. */
const LOCKED_FILES = new Set([
  "eslint.config.js",
  "eslint.config.mjs",
  ".prettierrc",
  ".prettierignore",
  "vitest.config.ts",
  "knip.json",
  "tsconfig.json",
  "tsconfig.test.json",
  "CLAUDE.md",
]);

/** Directories/prefixes for locked paths. */
const LOCKED_PREFIXES = ["scripts/crap-"];

function isLocked(filePath: string): boolean {
  const file = basename(filePath);
  if (LOCKED_FILES.has(file)) {
    return true;
  }
  for (const prefix of LOCKED_PREFIXES) {
    if (filePath.includes(prefix)) {
      return true;
    }
  }
  return false;
}

const BLOCK_REASON =
  "Quality gate file is locked. Do not modify linter, prettier, CRAP, coverage, knip, or tsconfig settings.";

export default function qualityGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const path = (event.input as { path?: string }).path ?? "";
      if (isLocked(path)) {
        return { block: true, reason: BLOCK_REASON };
      }
    }
    return undefined;
  });
}
