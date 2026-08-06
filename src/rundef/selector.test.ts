import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { registerBmadPayloadGates } from "../gates/index.js";
import {
  RunDefCompileError,
  clearPayloadGateRegistry,
  resolveRunDefSelection,
  selectAndCompileRunDef,
  selectRunDef,
} from "./index.js";

const discovered = [
  {
    id: "custom",
    path: "/repo/custom.yaml",
    runDef: {
      id: "custom",
      stages: [{ id: "dev", kind: "agent" as const, workflow: "dev", agent: "dev" }],
    },
  },
];

describe("RunDef selector", () => {
  it("selects and freezes discovered metadata", async () => {
    const selection = await selectRunDef("/repo", "custom", { discoveredRunDefs: discovered });
    expect(selection).toMatchObject({
      id: "custom",
      source: "discovered",
      path: "/repo/custom.yaml",
    });
    expect(Object.isFrozen(selection)).toBe(true);
  });

  it("returns undefined from catalog resolution when absent", () => {
    expect(resolveRunDefSelection("missing", discovered)).toBeUndefined();
  });

  it("fails missing discovered ids with a typed error and no builtin wording", async () => {
    await expect(selectRunDef("/repo", "sdlc", { discoveredRunDefs: [] })).rejects.toMatchObject({
      code: "rundef-not-found",
      id: "sdlc",
    });
    await expect(selectRunDef("/repo", "sdlc", { discoveredRunDefs: [] })).rejects.not.toThrow(
      /built-in/iu,
    );
  });

  it("validates ids and roots", async () => {
    await expect(
      selectRunDef(" ", "custom", { discoveredRunDefs: discovered }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      selectRunDef("/repo", "BAD", { discoveredRunDefs: discovered }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("compiles discovered definitions and honors timeout defaults", async () => {
    const selection = await selectAndCompileRunDef("/repo", "custom", {
      discoveredRunDefs: discovered,
      defaultTimeoutSeconds: 42,
    });
    expect(selection.stages[0]).toMatchObject({ id: "dev", timeoutSeconds: 42 });
    expect(Object.isFrozen(selection.stages)).toBe(true);
  });

  it("fails closed for an unregistered gate", async () => {
    clearPayloadGateRegistry();
    const gated = [
      {
        id: "gated",
        path: "/gated.yaml",
        runDef: {
          id: "gated",
          stages: [
            {
              id: "verify",
              kind: "agent" as const,
              workflow: "verify",
              agent: "tea",
              gate: "missing",
            },
          ],
        },
      },
    ];
    await expect(
      selectAndCompileRunDef("/repo", "gated", { discoveredRunDefs: gated }),
    ).rejects.toBeInstanceOf(RunDefCompileError);
  });

  it("discovers and compiles the repository SDLC YAML with registered gates", async () => {
    clearPayloadGateRegistry();
    registerBmadPayloadGates();
    const selection = await selectAndCompileRunDef(resolve(import.meta.dirname, "../.."), "sdlc");
    expect(selection.source).toBe("discovered");
    expect(selection.stages.map((stage) => stage.id)).toEqual([
      "create-story",
      "e2e-plan",
      "dev-story",
      "e2e-verify",
      "code-review",
      "docs",
    ]);
    expect(selection.stages[3]).toMatchObject({
      payloadGateName: "e2e-verify",
      onFail: "dev-story",
      timeoutSeconds: 7200,
    });
    expect(selection.stages[4]).toMatchObject({
      payloadGateName: "code-review",
      onFail: "dev-story",
      thinking: "high",
    });
  });

  it("propagates malformed discovered YAML errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "selector-"));
    const directory = join(root, ".pi/bmad/pipelines");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "bad.yaml"), "id: [", "utf8");
    await expect(selectRunDef(root, "bad")).rejects.toMatchObject({ code: "yaml-parse-failed" });
  });
});
