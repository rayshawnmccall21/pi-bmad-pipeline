/**
 * Vitest project for the built-CLI end-to-end mechanism suite.
 *
 * Separate from the locked vitest.config.ts on purpose: these tests spawn the
 * bundled `dist/src/cli.js` as a real child process against throwaway project
 * roots, so they run in their own project with their own timeouts and no
 * coverage requirement (coverage gates run in the main config).
 *
 * @packageDocumentation
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["tests/e2e/**/*.test.ts"],
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
