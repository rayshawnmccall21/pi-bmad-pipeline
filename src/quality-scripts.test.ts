import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("quality script entrypoints", () => {
  it.each([
    new URL("../scripts/crap-report.mjs", import.meta.url),
    new URL("../scripts/crap-ratchet.mjs", import.meta.url),
  ])("keeps load-bearing quality script %s available", (scriptUrl) => {
    expect(existsSync(fileURLToPath(scriptUrl))).toBe(true);
  });

  it("builds the ignored published bin before coverage tests", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["pretest:coverage"]).toBe("npm run build");
    expect(packageJson.scripts["precrap"]).toBe("npm run build");
  });

  it("ships a package skill with a catalog validator", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { files: string[]; pi: { skills: string[] } };
    const skillUrl = new URL("../skills/pi-bmad-pipeline-workflows/SKILL.md", import.meta.url);
    const runnerReferenceUrl = new URL(
      "../skills/pi-bmad-pipeline-workflows/references/runner-scripts.md",
      import.meta.url,
    );
    const validatorUrl = new URL(
      "../skills/pi-bmad-pipeline-workflows/scripts/validate-rundef.mjs",
      import.meta.url,
    );

    expect(packageJson.files).toContain("skills/");
    expect(packageJson.pi.skills).toEqual(["skills"]);
    expect(readFileSync(skillUrl, "utf8")).toContain("name: pi-bmad-pipeline-workflows");
    expect(existsSync(runnerReferenceUrl)).toBe(true);

    const fixtureDir = mkdtempSync(join(tmpdir(), "pi-bmad-pipeline-skill-"));
    const validPath = join(fixtureDir, "valid.yaml");
    const invalidPath = join(fixtureDir, "invalid.yaml");
    const projectRoot = join(fixtureDir, "project");
    const pipelineDir = join(projectRoot, ".pi", "bmad", "pipelines");
    writeFileSync(
      validPath,
      "id: valid\nstages:\n  - id: docs\n    kind: agent\n    workflow: docs\n    agent: architect\n",
    );
    writeFileSync(
      invalidPath,
      "id: invalid\nstages:\n  - id: dev\n    kind: agent\n    workflow: dev-story\n    agent: dev\n  - id: review\n    kind: agent\n    workflow: code-review\n    agent: dev\n    gate: missing\n    onFail: dev\n",
    );
    mkdirSync(pipelineDir, { recursive: true });
    writeFileSync(join(pipelineDir, "first.yaml"), readFileSync(validPath));
    writeFileSync(join(pipelineDir, "second.yaml"), readFileSync(validPath));

    try {
      const valid = spawnSync(process.execPath, [fileURLToPath(validatorUrl), validPath]);
      const invalid = spawnSync(process.execPath, [fileURLToPath(validatorUrl), invalidPath]);
      const duplicate = spawnSync(process.execPath, [
        fileURLToPath(validatorUrl),
        "--project-root",
        projectRoot,
      ]);
      const missing = spawnSync(process.execPath, [fileURLToPath(validatorUrl)]);

      expect(valid.status, valid.stderr.toString()).toBe(0);
      expect(valid.stdout.toString()).toContain("valid\t");
      expect(invalid.status).toBe(1);
      expect(duplicate.status).toBe(1);
      expect(duplicate.stderr.toString()).toContain('Duplicate discovered RunDef id "valid"');
      expect(missing.status).toBe(2);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
