import { describe, expect, it } from "vitest";

import {
  FINAL_SCOPE_RECEIPT_VERSION,
  compareFinalScopeToReview,
  createCanonicalRepositoryScope,
  createFinalScopeReceipt,
  createReviewScopeCheckpoint,
} from "./index.js";

const digestPattern = /^[a-f0-9]{64}$/u;
const encoded = (value: string): Uint8Array => new TextEncoder().encode(value);
const file = (path: string, value: string | Uint8Array) => ({
  path,
  bytes: typeof value === "string" ? encoded(value) : value,
});

const checkpointInput = () => ({
  storyId: "STY-144",
  runId: "run-144",
  runDefId: "create-story-dev-story-code-review-docs",
  runDefDigest: "a".repeat(64),
  branch: "sty-139/landing-integrity",
  baseOid: "b".repeat(40),
  reviewedFiles: [file("src/app.ts", "export const value = 1;\n")],
  qualityGate: {
    stageId: "code-review",
    attempt: 1,
    status: "passed" as const,
    finishedAt: "2026-08-18T00:00:00.000Z",
  },
});

describe("final scope receipt", () => {
  it("canonicalizes repository paths and hashes bytes deterministically", () => {
    const files = [
      file("src/z.ts", new Uint8Array([0, 255, 1])),
      file("README.md", "reviewed docs\n"),
    ];

    const scope = createCanonicalRepositoryScope(files);
    const reordered = createCanonicalRepositoryScope([...files].reverse());
    const changed = createCanonicalRepositoryScope([
      file("README.md", "reviewed docs changed\n"),
      files[0]!,
    ]);

    expect(scope.paths).toEqual(["README.md", "src/z.ts"]);
    expect(scope.digest).toMatch(digestPattern);
    expect(reordered).toEqual(scope);
    expect(changed.digest).not.toBe(scope.digest);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.paths)).toBe(true);

    expect(() => createCanonicalRepositoryScope([file("../outside.ts", "x")])).toThrow(
      /repository-relative|traversal/u,
    );
    expect(() => createCanonicalRepositoryScope([file("/absolute.ts", "x")])).toThrow(
      /repository-relative|absolute/u,
    );
    expect(() => createCanonicalRepositoryScope([file("docs/line\nbreak.md", "x")])).toThrow(
      /canonical|repository-relative/u,
    );
    expect(() =>
      createCanonicalRepositoryScope([file("src/a.ts", "one"), file("src/a.ts", "two")]),
    ).toThrow(/duplicate/u);
  });

  it("binds an immutable docs-only final receipt to the reviewed checkpoint", () => {
    const input = checkpointInput();
    const checkpoint = createReviewScopeCheckpoint(input);
    const finalFiles = [
      file("README.md", "documented after review\n"),
      file("src/app.ts", "export const value = 1;\n"),
    ];
    const comparison = compareFinalScopeToReview({
      checkpoint,
      finalFiles,
      allowedDocsPaths: ["README.md"],
    });

    expect(checkpoint).toEqual({
      version: FINAL_SCOPE_RECEIPT_VERSION,
      storyId: input.storyId,
      runId: input.runId,
      runDefId: input.runDefId,
      runDefDigest: input.runDefDigest,
      branch: input.branch,
      baseOid: input.baseOid,
      reviewed: createCanonicalRepositoryScope(input.reviewedFiles),
      qualityGate: input.qualityGate,
    });
    expect(comparison).toEqual({
      kind: "attested",
      docs: createCanonicalRepositoryScope([finalFiles[0]!]),
      finalWorkingTreeDigest: createCanonicalRepositoryScope(finalFiles).digest,
    });
    if (comparison.kind !== "attested") {
      expect.unreachable("The docs-only comparison should attest.");
    }

    const receipt = createFinalScopeReceipt({ checkpoint, comparison });

    expect(receipt).toEqual({
      version: FINAL_SCOPE_RECEIPT_VERSION,
      storyId: checkpoint.storyId,
      runId: checkpoint.runId,
      runDefId: checkpoint.runDefId,
      runDefDigest: checkpoint.runDefDigest,
      branch: checkpoint.branch,
      baseOid: checkpoint.baseOid,
      reviewed: checkpoint.reviewed,
      docs: comparison.docs,
      qualityGate: checkpoint.qualityGate,
      finalWorkingTreeDigest: comparison.finalWorkingTreeDigest,
    });
    expect(Object.isFrozen(checkpoint)).toBe(true);
    expect(Object.isFrozen(checkpoint.reviewed)).toBe(true);
    expect(Object.isFrozen(checkpoint.reviewed.paths)).toBe(true);
    expect(Object.isFrozen(checkpoint.qualityGate)).toBe(true);
    expect(Object.isFrozen(comparison)).toBe(true);
    expect(Object.isFrozen(comparison.docs)).toBe(true);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.docs)).toBe(true);
    expect(Object.isFrozen(receipt.docs.paths)).toBe(true);
  });

  it("invalidates review when a reviewed source byte changes", () => {
    const checkpoint = createReviewScopeCheckpoint(checkpointInput());

    const comparison = compareFinalScopeToReview({
      checkpoint,
      finalFiles: [
        file("README.md", "allowed docs\n"),
        file("src/app.ts", "export const value = 2;\n"),
      ],
      allowedDocsPaths: ["README.md"],
    });

    expect(comparison).toEqual({
      kind: "review-invalidated",
      changedPaths: ["src/app.ts"],
    });
    if (comparison.kind !== "review-invalidated") {
      expect.unreachable("Changed source bytes should invalidate review.");
    }
    expect(Object.isFrozen(comparison)).toBe(true);
    expect(Object.isFrozen(comparison.changedPaths)).toBe(true);
  });
});
