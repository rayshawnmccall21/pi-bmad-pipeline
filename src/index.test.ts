import { describe, expect, it } from "vitest";

import { PACKAGE_NAME, PACKAGE_VERSION } from "./index.js";

describe("package meta", () => {
  it("exports the package name", () => {
    expect(PACKAGE_NAME).toBe("pi-bmad-pipeline");
  });

  it("exports the package version", () => {
    expect(PACKAGE_VERSION).toBe("0.1.0");
  });
});
