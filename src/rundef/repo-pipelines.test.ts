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
        if (stage.gate !== undefined) {
          expect(registered).toContain(stage.gate);
        }
      }
    }
  });
});
