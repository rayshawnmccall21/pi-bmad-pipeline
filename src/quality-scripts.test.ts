import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const qualityScriptTimeoutMs = 15_000;

describe("quality script entrypoints", () => {
  it("keeps the locked dead-code configuration unchanged", () => {
    const knipConfig = JSON.parse(
      readFileSync(new URL("../knip.json", import.meta.url), "utf8"),
    ) as unknown;

    expect(knipConfig).toEqual({
      $schema: "https://unpkg.com/knip@5/schema.json",
      ignore: [".pi/**"],
      ignoreDependencies: ["pi-bmad", "@eslint/js", "@mariozechner/pi-coding-agent"],
    });
  });

  it.each([
    new URL("../scripts/crap-report.mjs", import.meta.url),
    new URL("../scripts/crap-ratchet.mjs", import.meta.url),
    new URL("../scripts/check-pi-bmad-freshness.mjs", import.meta.url),
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

  it("bounds every synchronous validator subprocess", () => {
    const testSource = readFileSync(import.meta.filename, "utf8");
    const validatorSpawnCalls = [...testSource.matchAll(/spawnSync\([^;]+;/gs)].map(
      ([spawnCall]) => spawnCall,
    );

    expect(validatorSpawnCalls).toHaveLength(4);
    for (const spawnCall of validatorSpawnCalls) {
      expect(spawnCall).toContain("timeout: qualityScriptTimeoutMs");
      expect(spawnCall).toContain('killSignal: "SIGKILL"');
    }
  });

  it(
    "ships a package skill with a parse-and-compile validator",
    () => {
      const packageJson = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { files: string[]; pi: { skills: string[] } };
      const skillUrl = new URL("../skills/pi-bmad-pipeline-workflows/SKILL.md", import.meta.url);
      const validatorUrl = new URL(
        "../skills/pi-bmad-pipeline-workflows/scripts/validate-rundef.mjs",
        import.meta.url,
      );

      expect(packageJson.files).toContain("skills/");
      expect(packageJson.pi.skills).toEqual(["skills"]);
      expect(readFileSync(skillUrl, "utf8")).toContain("name: pi-bmad-pipeline-workflows");

      const fixtureDir = mkdtempSync(join(tmpdir(), "pi-bmad-pipeline-skill-"));
      const validPath = join(fixtureDir, "valid.yaml");
      const validCodePath = join(fixtureDir, "valid-code.yaml");
      const invalidPath = join(fixtureDir, "invalid.yaml");
      writeFileSync(
        validPath,
        "id: valid\nstages:\n  - id: docs\n    kind: agent\n    workflow: docs\n    agent: architect\n",
      );
      writeFileSync(
        validCodePath,
        'id: valid-code\nstages:\n  - id: check\n    kind: code\n    command: npm\n    args: ["run", "check"]\n',
      );
      writeFileSync(
        invalidPath,
        "id: invalid\nstages:\n  - id: dev\n    kind: agent\n    workflow: dev-story\n    agent: dev\n  - id: review\n    kind: agent\n    workflow: code-review\n    agent: dev\n    gate: missing\n    onFail: dev\n",
      );

      try {
        const valid = spawnSync(process.execPath, [fileURLToPath(validatorUrl), validPath], {
          timeout: qualityScriptTimeoutMs,
          killSignal: "SIGKILL",
        });
        const validCode = spawnSync(
          process.execPath,
          [fileURLToPath(validatorUrl), validCodePath],
          {
            timeout: qualityScriptTimeoutMs,
            killSignal: "SIGKILL",
          },
        );
        const invalid = spawnSync(process.execPath, [fileURLToPath(validatorUrl), invalidPath], {
          timeout: qualityScriptTimeoutMs,
          killSignal: "SIGKILL",
        });
        const missing = spawnSync(process.execPath, [fileURLToPath(validatorUrl)], {
          timeout: qualityScriptTimeoutMs,
          killSignal: "SIGKILL",
        });

        expect(valid.status, valid.stderr.toString()).toBe(0);
        expect(valid.stdout.toString()).toContain("valid\t");
        expect(validCode.status, validCode.stderr.toString()).toBe(0);
        expect(validCode.stdout.toString()).toContain("valid-code\t");
        expect(invalid.status).toBe(1);
        expect(missing.status).toBe(2);
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
    qualityScriptTimeoutMs,
  );
});
