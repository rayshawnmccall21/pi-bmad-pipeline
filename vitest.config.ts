/**
 * Configures the Vitest test project for the pi-package-template.
 *
 * Sets Node execution and v8 coverage with the strict pi-bmad coverage floor. The json reporter is required so scripts/crap-report.mjs can read coverage/coverage-final.json.
 *
 * @packageDocumentation
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["src/**/*.test.ts"],
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/types.ts"],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
