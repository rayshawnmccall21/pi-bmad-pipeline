import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");
const standardAssets = [
  [
    ".pi/bmad/scripts/run-pipeline.py",
    "66e010b0b5858c914e673fe7b99ec6037d8c7407a44aa4f44073724aaa479054",
  ],
  [
    ".pi/bmad/pipelines/create-story_dev-story_code-review_docs.yaml",
    "3f76e1f234619d0ee2071f7418ac1a3aec72167589e77ba5b5bb9f72f730c8a9",
  ],
] as const;

const sha256 = (relativePath: string): string =>
  createHash("sha256")
    .update(readFileSync(resolve(projectRoot, relativePath)))
    .digest("hex");

describe("repository standard assets", () => {
  it.each(standardAssets)("%s matches the reviewed SHA-256", (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash);
  });

  it("has exactly one root-anchored worktree ignore rule", () => {
    const worktreeRules = readFileSync(resolve(projectRoot, ".gitignore"), "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.includes(".trees") && !line.startsWith("#"));

    expect(worktreeRules).toEqual(["/.trees/"]);
  });
});
