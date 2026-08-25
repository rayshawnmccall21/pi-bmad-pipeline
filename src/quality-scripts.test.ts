import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const qualityScriptTimeoutMs = 15_000;
const reviewGateValidatorUrl = new URL("../scripts/check-review-gate-locks.mjs", import.meta.url);
const executableShebang = "#!/usr/bin/env -S uv run --script";

describe("quality script entrypoints", () => {
  it("keeps the locked dead-code configuration unchanged", () => {
    const knipConfig = JSON.parse(
      readFileSync(new URL("../knip.json", import.meta.url), "utf8"),
    ) as unknown;

    expect(knipConfig).toEqual({
      $schema: "https://unpkg.com/knip@5/schema.json",
      entry: [
        "src/cli.ts",
        "src/cli-args.ts",
        "src/cli-command.ts",
        "src/cli-output.ts",
        "scripts/check-pi-bmad-freshness.mjs",
        "scripts/check-review-gate-locks.mjs",
        "scripts/crap-ratchet.mjs",
        "scripts/crap-report.mjs",
        "skills/pi-bmad-pipeline-workflows/scripts/validate-rundef.mjs",
        "tests/e2e/harness.ts",
        "tests/e2e/stub-pi.mjs",
      ],
      ignore: [".pi/**"],
      treatConfigHintsAsErrors: true,
      ignoreDependencies: ["pi-bmad", "@eslint/js"],
    });
  });

  it.each([
    new URL("../scripts/crap-report.mjs", import.meta.url),
    new URL("../scripts/crap-ratchet.mjs", import.meta.url),
    new URL("../scripts/check-pi-bmad-freshness.mjs", import.meta.url),
    reviewGateValidatorUrl,
  ])("keeps load-bearing quality script %s available", (scriptUrl) => {
    expect(existsSync(fileURLToPath(scriptUrl))).toBe(true);
  });

  it("wires every required tool and both strict Knip modes into the aggregate quality gate", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
    const checkTerms = packageJson.scripts["check"]?.split(" && ");

    expect(packageJson.scripts["check:review-gate-locks"]).toBe(
      "node scripts/check-review-gate-locks.mjs",
    );
    expect(packageJson.scripts["format"]).toBe(
      'prettier --write . "!knip.json" "!.pi/governance/quality-policy/STY-317.json"',
    );
    expect(packageJson.scripts["format:check"]).toBe(
      'prettier --check . "!knip.json" "!.pi/governance/quality-policy/STY-317.json"',
    );
    expect(packageJson.scripts["knip"]).toBe("knip --strict");
    expect(packageJson.scripts["knip:production"]).toBe(
      "knip --production --strict --include dependencies,unlisted,unresolved",
    );
    expect(Object.keys(packageJson.devDependencies)).toEqual(
      expect.arrayContaining(["typescript", "eslint", "prettier", "vitest", "knip"]),
    );
    expect(checkTerms).toEqual([
      "npm run check:pi-bmad",
      "npm run check:review-gate-locks",
      "npm run typecheck",
      "npm run format:check",
      "npm run lint",
      "npm run test:coverage",
      "npm run crap",
      "npm run conformance",
      "npm run test:e2e",
      "npm run knip",
      "npm run knip:production",
    ]);
  });

  it("provisions the pinned uv toolchain before the final aggregate quality gate", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const steps = workflow.split(/\n(?=\s{6}- )/);
    const nodeSetupIndex = steps.findIndex(
      (step) =>
        step.includes("uses: actions/setup-node@v4") && /^\s*node-version:\s*22\s*$/m.test(step),
    );
    const bunSetupIndex = steps.findIndex(
      (step) =>
        step.includes("uses: oven-sh/setup-bun@v2") &&
        /^\s*bun-version:\s*1\.3\.14\s*$/m.test(step),
    );
    const uvSetupIndex = steps.findIndex(
      (step) =>
        /uses:\s*astral-sh\/setup-uv@\S+/.test(step) &&
        /^\s*version:\s*["']?0\.9\.26["']?\s*$/m.test(step),
    );
    const qualityGateIndexes = steps.flatMap((step, index) =>
      /^\s*run:\s*npm run check\s*$/m.test(step) ? [index] : [],
    );

    expect(nodeSetupIndex).toBeGreaterThanOrEqual(0);
    expect(bunSetupIndex).toBeGreaterThanOrEqual(0);
    expect(uvSetupIndex).toBeGreaterThanOrEqual(0);
    expect(qualityGateIndexes).toEqual([steps.length - 1]);
    expect(uvSetupIndex).toBeLessThan(qualityGateIndexes[0]!);
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

    expect(validatorSpawnCalls).toHaveLength(13);
    for (const spawnCall of validatorSpawnCalls) {
      expect(spawnCall).toContain("timeout: qualityScriptTimeoutMs");
      expect(spawnCall).toContain('killSignal: "SIGKILL"');
    }
  });

  it(
    "validates all ten repository review-gate entrypoints against adjacent fresh locks",
    () => {
      const reviewGatesRoot = fileURLToPath(new URL("../tools/review-gates/", import.meta.url));
      const executableScripts = readdirSync(reviewGatesRoot)
        .filter((name) => name.endsWith(".py"))
        .filter((name) => {
          const source = readFileSync(join(reviewGatesRoot, name), "utf8");
          return source.split("\n", 1)[0] === executableShebang;
        })
        .sort();

      const result = spawnSync(process.execPath, [fileURLToPath(reviewGateValidatorUrl)], {
        timeout: qualityScriptTimeoutMs,
        killSignal: "SIGKILL",
      });

      expect(executableScripts).toHaveLength(10);
      expect(
        executableScripts.filter((name) => !existsSync(join(reviewGatesRoot, `${name}.lock`))),
      ).toEqual([]);
      expect(result.status, result.stderr.toString()).toBe(0);
    },
    qualityScriptTimeoutMs,
  );

  it(
    "accepts valid locks, discovers future names, excludes non-entrypoints, and preserves bytes",
    () => {
      const fixtureDir = mkdtempSync(join(tmpdir(), "review-gate-locks-valid-"));
      const binDir = join(fixtureDir, "bin");
      const nestedDir = join(fixtureDir, "tests");
      const scriptPath = join(fixtureDir, "future_entrypoint.py");
      const lockPath = `${scriptPath}.lock`;
      const commonPath = join(fixtureDir, "_common.py");
      const ordinaryPath = join(fixtureDir, "ordinary.py");
      const nestedPath = join(nestedDir, "nested.py");
      const uvPath = join(binDir, "uv");

      mkdirSync(binDir);
      mkdirSync(nestedDir);
      writeFileSync(
        scriptPath,
        `${executableShebang}\n# /// script\n# requires-python = ">=3.12"\n# ///\n`,
      );
      writeFileSync(lockPath, 'version = 1\nrevision = 3\nrequires-python = ">=3.12"\n');
      writeFileSync(commonPath, "raise RuntimeError('must not execute')\n");
      writeFileSync(ordinaryPath, "#!/usr/bin/env python3\n");
      writeFileSync(nestedPath, `${executableShebang}\n`);
      writeFileSync(
        uvPath,
        "#!/bin/sh\n" +
          'test "$1" = lock\n' +
          'test "$2" = --check\n' +
          'test "$3" = --script\n' +
          `test "$4" = "${scriptPath}"\n`,
      );
      chmodSync(uvPath, 0o755);

      const before = new Map(
        [scriptPath, lockPath, commonPath, ordinaryPath, nestedPath].map((path) => [
          path,
          readFileSync(path),
        ]),
      );

      try {
        const result = spawnSync(
          process.execPath,
          [fileURLToPath(reviewGateValidatorUrl), "--root", fixtureDir],
          {
            env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
            timeout: qualityScriptTimeoutMs,
            killSignal: "SIGKILL",
          },
        );

        expect(result.status, result.stderr.toString()).toBe(0);
        expect(result.error).toBeUndefined();
        for (const [path, bytes] of before) {
          expect(readFileSync(path)).toEqual(bytes);
        }
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
    qualityScriptTimeoutMs,
  );

  it(
    "rejects a missing adjacent lock without creating it",
    () => {
      const fixtureDir = mkdtempSync(join(tmpdir(), "review-gate-locks-missing-"));
      const scriptPath = join(fixtureDir, "missing.py");
      const lockPath = `${scriptPath}.lock`;
      writeFileSync(scriptPath, `${executableShebang}\n`);

      try {
        const result = spawnSync(
          process.execPath,
          [fileURLToPath(reviewGateValidatorUrl), "--root", fixtureDir],
          {
            timeout: qualityScriptTimeoutMs,
            killSignal: "SIGKILL",
          },
        );

        expect(result.status).toBe(1);
        expect(result.stderr.toString()).toMatch(/missing\.py/i);
        expect(result.stderr.toString()).toMatch(/lock/i);
        expect(existsSync(lockPath)).toBe(false);
        expect(readFileSync(scriptPath, "utf8")).toBe(`${executableShebang}\n`);
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
    qualityScriptTimeoutMs,
  );

  it(
    "rejects a stale lock and preserves script and lock bytes",
    () => {
      const fixtureDir = mkdtempSync(join(tmpdir(), "review-gate-locks-stale-"));
      const binDir = join(fixtureDir, "bin");
      const scriptPath = join(fixtureDir, "stale.py");
      const lockPath = `${scriptPath}.lock`;
      const uvPath = join(binDir, "uv");
      mkdirSync(binDir);
      writeFileSync(scriptPath, `${executableShebang}\n# stale metadata\n`);
      writeFileSync(lockPath, "stale lock bytes\n");
      writeFileSync(uvPath, "#!/bin/sh\necho 'lock is stale' >&2\nexit 1\n");
      chmodSync(uvPath, 0o755);
      const scriptBytes = readFileSync(scriptPath);
      const lockBytes = readFileSync(lockPath);

      try {
        const result = spawnSync(
          process.execPath,
          [fileURLToPath(reviewGateValidatorUrl), "--root", fixtureDir],
          {
            env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
            timeout: qualityScriptTimeoutMs,
            killSignal: "SIGKILL",
          },
        );

        expect(result.status).toBe(1);
        expect(result.stderr.toString()).toMatch(/stale\.py/i);
        expect(result.stderr.toString()).toMatch(/stale|fresh|lock/i);
        expect(readFileSync(scriptPath)).toEqual(scriptBytes);
        expect(readFileSync(lockPath)).toEqual(lockBytes);
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
    qualityScriptTimeoutMs,
  );

  it(
    "fails closed when no executable entrypoints are discovered",
    () => {
      const fixtureDir = mkdtempSync(join(tmpdir(), "review-gate-locks-empty-"));
      writeFileSync(join(fixtureDir, "_common.py"), "pass\n");
      writeFileSync(join(fixtureDir, "ordinary.py"), "#!/usr/bin/env python3\n");

      try {
        const result = spawnSync(
          process.execPath,
          [fileURLToPath(reviewGateValidatorUrl), "--root", fixtureDir],
          {
            timeout: qualityScriptTimeoutMs,
            killSignal: "SIGKILL",
          },
        );

        expect(result.status).toBe(2);
        expect(result.stderr.toString()).toMatch(/no .*entry|no .*script|zero/i);
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
    qualityScriptTimeoutMs,
  );

  it(
    "rejects invalid invocation and invalid roots",
    () => {
      const missingRoot = join(tmpdir(), `absent-review-gates-${process.pid}`);

      const invalidInvocation = spawnSync(
        process.execPath,
        [fileURLToPath(reviewGateValidatorUrl), "--unknown"],
        {
          timeout: qualityScriptTimeoutMs,
          killSignal: "SIGKILL",
        },
      );
      const invalidRoot = spawnSync(
        process.execPath,
        [fileURLToPath(reviewGateValidatorUrl), "--root", missingRoot],
        {
          timeout: qualityScriptTimeoutMs,
          killSignal: "SIGKILL",
        },
      );

      expect(invalidInvocation.status).toBe(2);
      expect(invalidInvocation.stderr.toString()).toMatch(/usage|unknown|--root/i);
      expect(invalidRoot.status).toBe(2);
      expect(invalidRoot.stderr.toString()).toMatch(/root|directory|exist/i);
    },
    qualityScriptTimeoutMs,
  );

  it(
    "fails closed when uv is unavailable",
    () => {
      const fixtureDir = mkdtempSync(join(tmpdir(), "review-gate-locks-no-uv-"));
      const emptyBinDir = join(fixtureDir, "empty-bin");
      const scriptPath = join(fixtureDir, "entry.py");
      mkdirSync(emptyBinDir);
      writeFileSync(scriptPath, `${executableShebang}\n`);
      writeFileSync(`${scriptPath}.lock`, "lock bytes\n");

      try {
        const result = spawnSync(
          process.execPath,
          [fileURLToPath(reviewGateValidatorUrl), "--root", fixtureDir],
          {
            env: { ...process.env, PATH: emptyBinDir },
            timeout: qualityScriptTimeoutMs,
            killSignal: "SIGKILL",
          },
        );

        expect(result.status).toBe(2);
        expect(result.stderr.toString()).toMatch(/uv/i);
        expect(result.stderr.toString()).toMatch(/not found|unavailable|spawn|enoent/i);
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
    qualityScriptTimeoutMs,
  );

  it(
    "fails closed when the uv freshness check times out",
    () => {
      const fixtureDir = mkdtempSync(join(tmpdir(), "review-gate-locks-timeout-"));
      const binDir = join(fixtureDir, "bin");
      const scriptPath = join(fixtureDir, "entry.py");
      const uvPath = join(binDir, "uv");
      mkdirSync(binDir);
      writeFileSync(scriptPath, `${executableShebang}\n`);
      writeFileSync(`${scriptPath}.lock`, "lock bytes\n");
      writeFileSync(uvPath, "#!/bin/sh\nsleep 30\n");
      chmodSync(uvPath, 0o755);

      try {
        const result = spawnSync(
          process.execPath,
          [fileURLToPath(reviewGateValidatorUrl), "--root", fixtureDir],
          {
            env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
            timeout: qualityScriptTimeoutMs,
            killSignal: "SIGKILL",
          },
        );

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(2);
        expect(result.stderr.toString()).toMatch(/timed? ?out|timeout/i);
        expect(result.stderr.length).toBeLessThan(4096);
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
    qualityScriptTimeoutMs,
  );

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
