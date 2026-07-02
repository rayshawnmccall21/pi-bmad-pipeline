/**
 * Configures the pi-bmad checkpoint-conformance vitest run.
 *
 * Separate from the locked vitest.config.ts on purpose: the
 * `pi-bmad/checkpoint-conformance` subpath resolves to TypeScript source
 * inside node_modules, which plain-Node vitest externalizes by default.
 * `server.deps.inline` pins pi-bmad to be transformed like first-party source
 * (the documented consumption recipe in pi-bmad docs/modules/checkpoints.md),
 * so the suite keeps loading even if vitest's externalization heuristics
 * change. No coverage here — coverage gates run in the main config.
 *
 * @packageDocumentation
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["tests/checkpoint-conformance.test.ts"],
    server: { deps: { inline: [/node_modules\/pi-bmad\//] } },
  },
});
