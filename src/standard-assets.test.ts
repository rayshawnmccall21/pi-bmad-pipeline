import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");
const standardAssets = [
  [
    ".pi/bmad/scripts/run-pipeline.py",
    "d698541121d53027e6dbf9fab17cbefa8cb3d42695862990dd687e7579b26632",
  ],
  [
    ".pi/bmad/pipelines/create-story_dev-story_code-review_docs.yaml",
    "3f76e1f234619d0ee2071f7418ac1a3aec72167589e77ba5b5bb9f72f730c8a9",
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
