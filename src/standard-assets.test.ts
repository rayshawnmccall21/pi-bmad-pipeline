import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");
const standardAssets = [
  [
    ".pi/bmad/scripts/run-pipeline.py",
    "73fbd8c7b2cfee2b8048c2c6328581042979f47a61b75d5d8d6cc9c0dcc34c3d",
  ],
  [
    ".pi/bmad/pipelines/create-story_dev-story_code-review_docs.yaml",
    "40e230b79eb161d49d7abb6c28a96261b111c9fe25199f455c8a42d417000a15",
  ],
] as const;

const readRegularFile = (relativePath: string): Buffer => {
  const path = resolve(projectRoot, relativePath);
  const stats = lstatSync(path);

  expect(stats.isFile()).toBe(true);
  expect(stats.isSymbolicLink()).toBe(false);
  return readFileSync(path);
};

const sha256 = (relativePath: string): string =>
  createHash("sha256").update(readRegularFile(relativePath)).digest("hex");

describe("repository standard assets", () => {
  it.each(standardAssets)("%s matches the reviewed SHA-256", (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash);
  });

  it("has exactly one root-anchored worktree ignore rule", () => {
    const worktreeRules = readRegularFile(".gitignore")
      .toString("utf8")
      .split(/\r?\n/u)
      .filter((line) => line.includes(".trees") && !line.startsWith("#"));

    expect(worktreeRules).toEqual(["/.trees/"]);
  });

  it("keeps file-type and ignore-line checks source-exact", () => {
    const testSource = readFileSync(
      resolve(import.meta.dirname, "standard-assets.test.ts"),
      "utf8",
    );

    expect(testSource).toMatch(/\blstatSync\(/u);
    expect(testSource).not.toMatch(/\bline\.trim\(\)/u);
  });
});
