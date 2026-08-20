/**
 * Repository RunDef catalog conformance: every discovered pipeline under
 * `.pi/bmad/pipelines/` must keep compiling against the live schema and the
 * registered BMAD payload gates. Guards the repository's self-supervision
 * definitions from drifting away from the compiled contract.
 */
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { registerBmadPayloadGates } from "../gates/index.js";
import {
  discoverRunDefs,
  listPayloadGateNames,
  payloadGateRegistry,
  selectAndCompileRunDef,
} from "./index.js";

const projectRoot = resolve(import.meta.dirname, "../..");

describe("repository pipeline catalog", () => {
  it("compiles every discovered RunDef with registered payload gates", async () => {
    registerBmadPayloadGates();
    const discovered = await discoverRunDefs(projectRoot);

    expect(discovered.length).toBeGreaterThan(0);

    for (const entry of discovered) {
      const compiled = await selectAndCompileRunDef(projectRoot, entry.id, {
        registry: payloadGateRegistry,
      });
      expect(compiled.id).toBe(entry.id);
      expect(compiled.stages.length).toBeGreaterThan(0);
    }
  });

  it("uses only registered payload gates across the catalog", async () => {
    registerBmadPayloadGates();
    const discovered = await discoverRunDefs(projectRoot);
    const registered = listPayloadGateNames();

    for (const entry of discovered) {
      for (const stage of entry.runDef.stages) {
        if ("gate" in stage && stage.gate !== undefined) {
          expect(registered).toContain(stage.gate);
        }
      }
    }
  });

  it("regresses the reusable implementation pipeline only through the critical-only gate", async () => {
    registerBmadPayloadGates();
    const discovered = await discoverRunDefs(projectRoot);
    const pipeline = discovered.find(
      (entry) => entry.id === "create-story-dev-story-code-review-docs",
    );
    const review = pipeline?.runDef.stages.find((stage) => stage.id === "code-review");
    const criticalOnlyConsumers = discovered.flatMap((entry) =>
      entry.runDef.stages
        .filter((stage) => "gate" in stage && stage.gate === "code-review-critical-only")
        .map((stage) => `${entry.id}:${stage.id}`),
    );
    const strictReviewConsumers = discovered.flatMap((entry) =>
      entry.runDef.stages
        .filter((stage) => "gate" in stage && stage.gate === "code-review")
        .map((stage) => `${entry.id}:${stage.id}`),
    );

    expect(review).toMatchObject({
      kind: "agent",
      gate: "code-review-critical-only",
      onFail: "dev-story",
    });
    expect(criticalOnlyConsumers).toEqual(["create-story-dev-story-code-review-docs:code-review"]);
    expect(strictReviewConsumers).toEqual(["sdlc:code-review", "strip:code-review"]);
  });

  it("loads the quality guard in every self-supervision agent stage", async () => {
    const discovered = await discoverRunDefs(projectRoot);
    const pipeline = discovered.find(
      (entry) => entry.id === "create-story-dev-story-code-review-docs",
    );

    expect(pipeline).toBeDefined();
    for (const stage of pipeline?.runDef.stages ?? []) {
      expect(stage.kind).toBe("agent");
      if (stage.kind === "agent") {
        expect(stage.extensions).toContain(".pi/extensions/quality-guard.ts");
      }
    }
  });
});
