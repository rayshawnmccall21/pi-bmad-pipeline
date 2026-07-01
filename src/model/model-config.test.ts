import { describe, expect, it } from "vitest";

import {
  DEFAULT_PIPELINE_MODEL,
  DEFAULT_PIPELINE_THINKING,
  ModelConfigError,
  assertResolvedModelConfig,
  isModelThinking,
  resolveModelConfig,
} from "./index.js";

describe("model config resolver", () => {
  it("resolves built-in defaults when request is absent", () => {
    expect(resolveModelConfig()).toEqual({
      model: DEFAULT_PIPELINE_MODEL,
      thinking: DEFAULT_PIPELINE_THINKING,
      modelSource: "default",
      thinkingSource: "default",
    });
  });

  it("uses caller defaults over built-in defaults", () => {
    expect(
      resolveModelConfig({ defaults: { model: "default/model", thinking: "high" } }),
    ).toMatchObject({
      model: "default/model",
      thinking: "high",
      modelSource: "default",
      thinkingSource: "default",
    });
  });

  it("uses environment over defaults", () => {
    expect(
      resolveModelConfig({
        environment: { model: "env/model", thinking: "low" },
        defaults: { model: "default/model", thinking: "high" },
      }),
    ).toMatchObject({ model: "env/model", thinking: "low", modelSource: "environment" });
  });

  it("uses project over environment", () => {
    expect(
      resolveModelConfig({
        project: { model: "project/model", thinking: "medium" },
        environment: { model: "env/model", thinking: "low" },
      }),
    ).toMatchObject({ model: "project/model", thinking: "medium", modelSource: "project" });
  });

  it("uses stage over project", () => {
    expect(
      resolveModelConfig({
        stage: { model: "stage/model", thinking: "high" },
        project: { model: "project/model", thinking: "medium" },
      }),
    ).toMatchObject({ model: "stage/model", thinking: "high", modelSource: "stage" });
  });

  it("uses explicit over all other sources", () => {
    expect(
      resolveModelConfig({
        explicit: { model: "explicit/model", thinking: "low" },
        stage: { model: "stage/model", thinking: "high" },
        project: { model: "project/model", thinking: "medium" },
        environment: { model: "env/model", thinking: "low" },
        defaults: { model: "default/model", thinking: "high" },
      }),
    ).toMatchObject({ model: "explicit/model", thinking: "low", modelSource: "explicit" });
  });

  it("resolves model and thinking independently from different sources", () => {
    expect(
      resolveModelConfig({
        explicit: { model: "explicit/model" },
        stage: { thinking: "high" },
        project: { model: "project/model", thinking: "medium" },
      }),
    ).toEqual({
      model: "explicit/model",
      thinking: "high",
      modelSource: "explicit",
      thinkingSource: "stage",
    });
  });

  it("trims resolved model", () => {
    expect(resolveModelConfig({ explicit: { model: "  explicit/model  " } }).model).toBe(
      "explicit/model",
    );
  });

  it.each(["low", "medium", "high"])("accepts thinking %j", (thinking) => {
    expect(isModelThinking(thinking)).toBe(true);
  });

  it.each(["", "MEDIUM", "ultra"])("rejects thinking %j", (thinking) => {
    expect(isModelThinking(thinking)).toBe(false);
  });

  it("throws ModelConfigError for selected blank model", () => {
    expect(() => resolveModelConfig({ explicit: { model: " " } })).toThrow(ModelConfigError);
  });

  it("throws ModelConfigError for selected invalid thinking", () => {
    expect(() => resolveModelConfig({ project: { thinking: "ultra" } })).toThrow(ModelConfigError);
  });

  it("ignores invalid lower-priority values when higher-priority values win", () => {
    expect(
      resolveModelConfig({
        explicit: { model: "explicit/model", thinking: "high" },
        project: { model: " ", thinking: "ultra" },
      }),
    ).toMatchObject({ model: "explicit/model", thinking: "high" });
  });

  it("exposes frozen error issues", () => {
    try {
      resolveModelConfig({ explicit: { model: " " } });
      expect.unreachable("resolveModelConfig should throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelConfigError);
      if (error instanceof ModelConfigError) {
        expect(error.issues).toEqual([
          { path: "/explicit/model", message: "Model must not be blank." },
        ]);
        expect(Object.isFrozen(error.issues)).toBe(true);
        expect(Object.isFrozen(error.issues[0])).toBe(true);
      }
    }
  });

  it("returns a frozen resolved config", () => {
    expect(Object.isFrozen(resolveModelConfig())).toBe(true);
  });

  it("assertResolvedModelConfig accepts valid config", () => {
    expect(() => {
      assertResolvedModelConfig(resolveModelConfig());
    }).not.toThrow();
  });

  it("assertResolvedModelConfig throws for blank model or invalid thinking", () => {
    expect(() => {
      assertResolvedModelConfig({
        model: " ",
        thinking: "ultra" as never,
        modelSource: "explicit",
        thinkingSource: "explicit",
      });
    }).toThrow(ModelConfigError);
  });
});
