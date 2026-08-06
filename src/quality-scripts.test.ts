import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("quality script entrypoints", () => {
  it.each([
    new URL("../scripts/crap-report.mjs", import.meta.url),
    new URL("../scripts/crap-ratchet.mjs", import.meta.url),
  ])("keeps load-bearing quality script %s available", (scriptUrl) => {
    expect(existsSync(fileURLToPath(scriptUrl))).toBe(true);
  });
});
