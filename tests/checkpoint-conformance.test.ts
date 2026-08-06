/**
 * Downstream pi-bmad checkpoint conformance (plan AC9).
 *
 * Runs the `pi-bmad/checkpoint-conformance` suite against this repo's project
 * checkpoint roots (`.pi/workflows/checkpoints/`) inside `npm run check`
 * without booting Pi. Executed through vitest.conformance.config.ts, which
 * carries the required `server.deps.inline` entry for the TS-source subpath.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defineCheckpointConformance } from "pi-bmad/checkpoint-conformance";

// The strongest success-claiming module state the e2e module gate could see
// with NO verifiable per-probe proof: base fields and summary counts all claim
// green while the probes array carries zero records to recompute them from.
// The gate must still fail closed.
const e2eModuleGateOverClaim = JSON.stringify({
  checkpoint: "pipeline--e2e-module-gate",
  status: "passed",
  storyId: "E2E-CHECKPOINT-1",
  probes: [],
  totalProbes: 3,
  passedProbes: 3,
  allProbesPassed: true,
});

const suite = defineCheckpointConformance({
  projectRoot: process.cwd(),
  overClaimEvidence: {
    "pipeline--e2e-module-gate": e2eModuleGateOverClaim,
  },
});

describe("pi-bmad checkpoint conformance", () => {
  it("does not discover the removed policy checkpoint", () => {
    const removedModuleBasename = ["merge", "gate.mjs"].join("-");
    const removedModulePath = join(
      process.cwd(),
      ".pi/workflows/checkpoints",
      removedModuleBasename,
    );

    expect(existsSync(removedModulePath)).toBe(false);
  });

  for (const check of suite.checks) {
    it(check.name, async () => {
      const outcome = await check.run();
      expect(outcome.failures).toEqual([]);
    });
  }
});
