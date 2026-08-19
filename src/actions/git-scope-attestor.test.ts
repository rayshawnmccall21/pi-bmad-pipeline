import { describe, expect, it, vi } from "vitest";

import { createGitScopeAttestor } from "./git-scope-attestor.js";

const digest = (character: string): string => character.repeat(64);
const encoded = (value: string): Uint8Array => new TextEncoder().encode(value);

const identity = {
  projectRoot: "/repo",
  storyId: "STY-144",
  runId: "run-144",
  runDefId: "create-story-dev-story-code-review-docs",
  runDefDigest: digest("a"),
};

const qualityGate = {
  stageId: "code-review",
  attempt: 1,
  status: "passed" as const,
  finishedAt: "2026-08-18T00:00:00.000Z",
};

describe("createGitScopeAttestor", () => {
  it("builds a Git-derived review checkpoint and docs-bound final receipt", async () => {
    const fileBytes = new Map([
      ["README.md", encoded("docs\n")],
      ["src/app.ts", encoded("source\n")],
      ["tests/app.test.ts", encoded("test\n")],
    ]);
    const runGit = vi.fn(async (_root: string, args: readonly string[]) => {
      const command = args.join(" ");
      if (command === "symbolic-ref --quiet --short HEAD") return "sty-139/landing-integrity\n";
      if (command === "rev-parse main" || command === "rev-parse HEAD") {
        return `${"b".repeat(40)}\n`;
      }
      if (command === "status --porcelain=v1 -z --untracked-files=all") {
        return " M README.md\0 M src/app.ts\0?? tests/app.test.ts\0";
      }
      throw new Error(`Unexpected git command: ${command}`);
    });
    const attest = createGitScopeAttestor({
      runGit,
      readBytes: async (_root, path) => fileBytes.get(path)!,
    });

    const review = await attest({ phase: "review", ...identity, qualityGate });
    expect(review.kind).toBe("review-checkpoint");
    if (review.kind !== "review-checkpoint") expect.unreachable("review should attest");
    expect(review.checkpoint.reviewed.paths).toEqual(["src/app.ts", "tests/app.test.ts"]);
    expect(review.checkpoint.branch).toBe("sty-139/landing-integrity");

    const final = await attest({
      phase: "final",
      ...identity,
      reviewCheckpoint: review.checkpoint,
      qualityGate,
    });
    expect(final.kind).toBe("final-receipt");
    if (final.kind !== "final-receipt") expect.unreachable("final scope should attest");
    expect(final.receipt.docs.paths).toEqual(["README.md"]);
    expect(final.receipt.reviewed).toEqual(review.checkpoint.reviewed);
  });

  it("invalidates review when a reviewed byte changes after approval", async () => {
    const fileBytes = new Map([
      ["src/app.ts", encoded("source\n")],
      ["README.md", encoded("docs\n")],
    ]);
    const attest = createGitScopeAttestor({
      runGit: async (_root, args) => {
        const command = args.join(" ");
        if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
        if (command === "rev-parse main" || command === "rev-parse HEAD") {
          return `${"b".repeat(40)}\n`;
        }
        return " M README.md\0 M src/app.ts\0";
      },
      readBytes: async (_root, path) => fileBytes.get(path)!,
    });
    const review = await attest({ phase: "review", ...identity, qualityGate });
    if (review.kind !== "review-checkpoint") expect.unreachable("review should attest");
    fileBytes.set("src/app.ts", encoded("changed\n"));

    await expect(
      attest({ phase: "final", ...identity, reviewCheckpoint: review.checkpoint, qualityGate }),
    ).resolves.toEqual({ kind: "review-invalidated", changedPaths: ["src/app.ts"] });
  });
});
