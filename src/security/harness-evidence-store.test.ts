import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HARNESS_EVIDENCE_FILE_NAME,
  HARNESS_EVIDENCE_RELATIVE_DIR,
  HarnessEvidenceStoreError,
  getHarnessEvidenceDir,
  getHarnessEvidencePath,
  getHarnessEvidenceStoryDir,
  loadHarnessEvidence,
  saveHarnessEvidence,
} from "./index.js";

import type { HarnessEvidenceReport } from "./index.js";

const roots: string[] = [];
const storyId = "STORY-123";

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pipeline-evidence-"));
  roots.push(root);
  return root;
};

const report = (projectRoot: string): HarnessEvidenceReport => ({
  projectRoot,
  startedAt: "2026-07-01T00:00:00.000Z",
  finishedAt: "2026-07-01T00:00:01.000Z",
  passed: true,
  commands: [
    {
      name: "test",
      command: "npm",
      args: ["test"],
      status: "passed",
      exitCode: 0,
      durationMs: 100,
      stdout: "ok",
      stderr: "",
    },
  ],
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("harness evidence store", () => {
  it("exports path constants", () => {
    expect(HARNESS_EVIDENCE_RELATIVE_DIR).toBe(".pi/pipeline/evidence");
    expect(HARNESS_EVIDENCE_FILE_NAME).toBe("harness-evidence.json");
  });

  it("resolves evidence paths", async () => {
    const root = await tempRoot();

    expect(getHarnessEvidenceDir(root)).toBe(join(root, ".pi", "pipeline", "evidence"));
    expect(getHarnessEvidenceStoryDir(root, storyId)).toBe(
      join(root, ".pi", "pipeline", "evidence", storyId),
    );
    expect(getHarnessEvidencePath(root, storyId)).toBe(
      join(root, ".pi", "pipeline", "evidence", storyId, "harness-evidence.json"),
    );
  });

  it("rejects blank project root", () => {
    expect(() => getHarnessEvidenceDir(" ")).toThrow(
      new RangeError("Project root must not be blank."),
    );
  });

  it("rejects unsafe story ids", async () => {
    const root = await tempRoot();

    expect(() => getHarnessEvidencePath(root, "../bad")).toThrow(
      new RangeError('Invalid harness evidence story id "../bad".'),
    );
  });

  it("saves report to story artifact path", async () => {
    const root = await tempRoot();

    await expect(
      saveHarnessEvidence({ projectRoot: root, storyId, report: report(root) }),
    ).resolves.toBe(getHarnessEvidencePath(root, storyId));
  });

  it("creates parent directories", async () => {
    const root = await tempRoot();
    const path = await saveHarnessEvidence({ projectRoot: root, storyId, report: report(root) });

    await expect(readFile(path, "utf8")).resolves.toContain('"projectRoot"');
  });

  it("writes deterministic pretty JSON with trailing newline", async () => {
    const root = await tempRoot();
    const evidence = report(root);
    const path = await saveHarnessEvidence({ projectRoot: root, storyId, report: evidence });

    expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(evidence, null, 2)}\n`);
  });

  it("loads saved report round-trip", async () => {
    const root = await tempRoot();
    const evidence = report(root);

    await saveHarnessEvidence({ projectRoot: root, storyId, report: evidence });

    await expect(loadHarnessEvidence({ projectRoot: root, storyId })).resolves.toEqual(evidence);
  });

  it("returns undefined for missing evidence", async () => {
    const root = await tempRoot();

    await expect(loadHarnessEvidence({ projectRoot: root, storyId })).resolves.toBeUndefined();
  });

  it("freezes loaded report and nested values", async () => {
    const root = await tempRoot();
    await saveHarnessEvidence({ projectRoot: root, storyId, report: report(root) });

    const loaded = await loadHarnessEvidence({ projectRoot: root, storyId });

    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded?.commands)).toBe(true);
    expect(Object.isFrozen(loaded?.commands[0])).toBe(true);
    expect(Object.isFrozen(loaded?.commands[0]?.args)).toBe(true);
  });

  it("throws json-parse-failed for invalid JSON", async () => {
    const root = await tempRoot();
    const path = getHarnessEvidencePath(root, storyId);
    await mkdir(getHarnessEvidenceStoryDir(root, storyId), { recursive: true });
    await writeFile(path, "not json", "utf8");

    await expect(loadHarnessEvidence({ projectRoot: root, storyId })).rejects.toMatchObject({
      code: "json-parse-failed",
    });
  });

  it("throws invalid-evidence for malformed reports", async () => {
    const root = await tempRoot();
    const path = getHarnessEvidencePath(root, storyId);
    await mkdir(getHarnessEvidenceStoryDir(root, storyId), { recursive: true });
    await writeFile(path, "{}\n", "utf8");

    await expect(loadHarnessEvidence({ projectRoot: root, storyId })).rejects.toMatchObject({
      code: "invalid-evidence",
    });
  });

  it("throws invalid-evidence for report projectRoot mismatch", async () => {
    const root = await tempRoot();

    await expect(
      saveHarnessEvidence({ projectRoot: root, storyId, report: report("/other") }),
    ).rejects.toMatchObject({ code: "invalid-evidence" });
  });

  it("throws read-failed when artifact path is a directory", async () => {
    const root = await tempRoot();
    await mkdir(getHarnessEvidencePath(root, storyId), { recursive: true });

    await expect(loadHarnessEvidence({ projectRoot: root, storyId })).rejects.toMatchObject({
      code: "read-failed",
    });
  });

  it("throws write-failed when evidence directory is blocked by a file", async () => {
    const root = await tempRoot();
    await writeFile(join(root, ".pi"), "blocked", "utf8");

    await expect(
      saveHarnessEvidence({ projectRoot: root, storyId, report: report(root) }),
    ).rejects.toMatchObject({
      code: "write-failed",
    });
  });

  it("does not mutate report input", async () => {
    const root = await tempRoot();
    const evidence = report(root);
    const before = JSON.stringify(evidence);

    await saveHarnessEvidence({ projectRoot: root, storyId, report: evidence });

    expect(JSON.stringify(evidence)).toBe(before);
  });

  it("sets store error fields", () => {
    const error = new HarnessEvidenceStoreError({
      code: "read-failed",
      path: "/tmp/file",
      storyId,
      reason: "nope",
    });

    expect(error).toMatchObject({
      code: "read-failed",
      path: "/tmp/file",
      storyId,
      reason: "nope",
    });
  });
});
