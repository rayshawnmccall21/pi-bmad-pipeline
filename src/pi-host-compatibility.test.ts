import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly bin?: Readonly<Record<string, string>>;
}

describe("reproducible Pi host", () => {
  it("installs the Earendil Pi 0.84.4 CLI manifest and bin without invoking a model", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
        "utf8",
      ),
    ) as PackageManifest;

    expect(manifest).toMatchObject({
      name: "@earendil-works/pi-coding-agent",
      version: "0.84.4",
      bin: { pi: "dist/bundle/cli.js" },
    });
  });
});
