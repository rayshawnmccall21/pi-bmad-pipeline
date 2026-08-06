import { describe, expect, it } from "vitest";

import {
  createPipelineEventEmitter,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  RUN_PIPELINE_ACTION_NAME,
  runPipelineAction,
  serializePipelineEvent,
} from "./index.js";

describe("package meta", () => {
  it("exports the package name", () => {
    expect(PACKAGE_NAME).toBe("pi-bmad-pipeline");
  });

  it("exports the package version", () => {
    expect(PACKAGE_VERSION).toBe("0.1.0");
  });
});

describe("public barrel surface", () => {
  it("exports the action subsystem", () => {
    expect(typeof runPipelineAction).toBe("function");
    expect(RUN_PIPELINE_ACTION_NAME).toBe("run");
  });

  it("exports the event wire protocol", () => {
    expect(typeof createPipelineEventEmitter).toBe("function");
    expect(typeof serializePipelineEvent).toBe("function");
  });
});
