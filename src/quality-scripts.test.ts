import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("quality script entrypoints", () => {
  it.each([
    new URL("../scripts/crap-report.mjs", import.meta.url),
    new URL("../scripts/crap-ratchet.mjs", import.meta.url),
  ])("keeps load-bearing quality script %s available", (scriptUrl) => {
    expect(existsSync(fileURLToPath(scriptUrl))).toBe(true);
  });

  it("builds the ignored published bin before coverage tests", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["pretest:coverage"]).toBe("npm run build");
    expect(packageJson.scripts["precrap"]).toBe("npm run build");
  });
});
