import { describe, expect, it } from "vitest";

import type { RepositoryFileSnapshot } from "./index.js";

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
const tombstone = (path: string) => ({
  path,
  absent: true as const,
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
    expect(scope.digest).toBe("b76b587d5f9479bf473291079b95efe94220be0182f594720fc71d652846b67c");
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

  it("hashes tombstones deterministically without aliasing present file content", () => {
    const files = [tombstone("src/removed.ts"), file("src/kept.ts", "kept\n")];
    const scope = createCanonicalRepositoryScope(files);
    const reordered = createCanonicalRepositoryScope([...files].reverse());
    const presentDigests = [
      new Uint8Array(),
      encoded("absent"),
      encoded("tombstone"),
      new Uint8Array([0, 255, 58, 49]),
    ].map(
      (bytes) =>
        createCanonicalRepositoryScope([
          file("src/removed.ts", bytes),
          file("src/kept.ts", "kept\n"),
        ]).digest,
    );

    expect(scope.paths).toEqual(["src/kept.ts", "src/removed.ts"]);
    expect(scope.digest).toMatch(digestPattern);
    expect(reordered).toEqual(scope);
    expect(presentDigests).not.toContain(scope.digest);
  });

  it("rejects a snapshot that is both present and absent", () => {
    const hybrid = {
      path: "src/impossible.ts",
      bytes: new Uint8Array(),
      absent: true,
    } as unknown as RepositoryFileSnapshot;

    expect(() => createCanonicalRepositoryScope([hybrid])).toThrow(/present|absent|snapshot/u);
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

  it("round-trips an unchanged reviewed tombstone into the final receipt", () => {
    const input = {
      ...checkpointInput(),
      reviewedFiles: [tombstone("src/removed.ts")],
    };
    const checkpoint = createReviewScopeCheckpoint(input);
    const finalFiles = [tombstone("src/removed.ts")];
    const comparison = compareFinalScopeToReview({
      checkpoint,
      finalFiles,
      allowedDocsPaths: [],
    });

    expect(comparison).toEqual({
      kind: "attested",
      docs: createCanonicalRepositoryScope([]),
      finalWorkingTreeDigest: createCanonicalRepositoryScope(finalFiles).digest,
    });
    if (comparison.kind !== "attested") {
      expect.unreachable("An unchanged reviewed tombstone should attest.");
    }

    const receipt = createFinalScopeReceipt({ checkpoint, comparison });

    expect(receipt.reviewed).toEqual(checkpoint.reviewed);
    expect(receipt.finalWorkingTreeDigest).toBe(comparison.finalWorkingTreeDigest);
  });

  it("invalidates review when a reviewed non-documentation file is deleted", () => {
    const checkpoint = createReviewScopeCheckpoint(checkpointInput());
    const comparison = compareFinalScopeToReview({
      checkpoint,
      finalFiles: [tombstone("src/app.ts")],
      allowedDocsPaths: [],
    });

    expect(comparison).toEqual({
      kind: "review-invalidated",
      changedPaths: ["src/app.ts"],
    });
    expect(() => createFinalScopeReceipt({ checkpoint, comparison })).toThrow(RangeError);
  });

  it("retains an exact allowlisted documentation tombstone in docs scope", () => {
    const checkpoint = createReviewScopeCheckpoint(checkpointInput());
    const finalFiles = [tombstone("README.md"), file("src/app.ts", "export const value = 1;\n")];
    const comparison = compareFinalScopeToReview({
      checkpoint,
      finalFiles,
      allowedDocsPaths: ["README.md"],
    });

    expect(comparison).toEqual({
      kind: "attested",
      docs: createCanonicalRepositoryScope([tombstone("README.md")]),
      finalWorkingTreeDigest: createCanonicalRepositoryScope(finalFiles).digest,
    });
  });

  it.each([
    "skills/pi-bmad-pipeline-workflows/SKILL.md",
    ".pi/prompts/reviewer.md",
    ".pi/artifacts/implementation/stories/STY-265.md",
    "tsconfig.json",
    ".github/workflows/check.yml",
    ".pi/agents/reviewer.md",
    "src/security/CONTEXT.md",
  ])("does not widen the docs deletion allowance to %s", (path) => {
    const checkpoint = createReviewScopeCheckpoint({
      ...checkpointInput(),
      reviewedFiles: [file(path, "reviewed\n")],
    });
    const comparison = compareFinalScopeToReview({
      checkpoint,
      finalFiles: [tombstone(path)],
      allowedDocsPaths: ["README.md"],
    });

    expect(comparison).toEqual({
      kind: "review-invalidated",
      changedPaths: [path],
    });
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
