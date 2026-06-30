import { describe, expect, it } from "vitest";

import { versionBanner } from "./cli.js";

describe("versionBanner", () => {
  it("includes the package name and version", () => {
    expect(versionBanner()).toBe("pi-bmad-pipeline v0.1.0");
  });
});
