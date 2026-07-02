import { isAbsolute, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PI_BMAD_EXTENSION_FALLBACK_PATH,
  PI_BMAD_EXTENSION_MODULE_SPECIFIER,
  PI_BMAD_EXTENSION_PATH_ENV_VAR,
  resolvePiBmadExtensionPath,
} from "./index.js";

describe("pi-bmad extension path resolver", () => {
  it("prefers an explicit path over every other source", () => {
    const resolveModule = vi.fn(() => "/modules/pi-bmad/extensions/pi-bmad.ts");

    const path = resolvePiBmadExtensionPath({
      explicitPath: "/custom/pi-bmad.ts",
      env: { [PI_BMAD_EXTENSION_PATH_ENV_VAR]: "/env/pi-bmad.ts" },
      resolveModule,
    });

    expect(path).toBe("/custom/pi-bmad.ts");
    expect(resolveModule).not.toHaveBeenCalled();
  });

  it("rejects a blank explicit path", () => {
    expect(() => resolvePiBmadExtensionPath({ explicitPath: " " })).toThrow(
      "explicitPath must not be blank.",
    );
  });

  it("uses the environment variable when no explicit path is given", () => {
    const path = resolvePiBmadExtensionPath({
      env: { [PI_BMAD_EXTENSION_PATH_ENV_VAR]: "/env/pi-bmad.ts" },
      resolveModule: () => "/modules/pi-bmad/extensions/pi-bmad.ts",
    });

    expect(path).toBe("/env/pi-bmad.ts");
  });

  it("ignores a blank environment value and resolves the module export", () => {
    const resolveModule = vi.fn(() => "/modules/pi-bmad/extensions/pi-bmad.ts");

    const path = resolvePiBmadExtensionPath({
      env: { [PI_BMAD_EXTENSION_PATH_ENV_VAR]: "  " },
      resolveModule,
    });

    expect(path).toBe("/modules/pi-bmad/extensions/pi-bmad.ts");
    expect(resolveModule).toHaveBeenCalledWith(PI_BMAD_EXTENSION_MODULE_SPECIFIER);
  });

  it("falls back to the sibling checkout when module resolution fails", () => {
    const path = resolvePiBmadExtensionPath({
      env: {},
      resolveModule: () => {
        throw new Error("Cannot find module");
      },
      fallbackRoot: "/repos/pi-bmad-pipeline",
    });

    expect(path).toBe(resolve("/repos/pi-bmad-pipeline", DEFAULT_PI_BMAD_EXTENSION_FALLBACK_PATH));
    expect(path).toBe("/repos/pi-bmad/extensions/pi-bmad.ts");
  });

  it("resolves the installed pi-bmad extension by default", () => {
    const path = resolvePiBmadExtensionPath({ env: {} });

    expect(isAbsolute(path)).toBe(true);
    expect(path).toContain("pi-bmad");
    expect(path.endsWith("pi-bmad.ts")).toBe(true);
  });
});
