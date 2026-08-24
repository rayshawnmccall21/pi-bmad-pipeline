import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");
const readProjectFile = (relativePath: string): string =>
  readFileSync(resolve(projectRoot, relativePath), "utf8");

describe("narrowed mission documentation", () => {
  it("does not advertise removed policy modules or CLI commands", () => {
    const publicDocumentation = [readProjectFile("README.md"), readProjectFile("CONTEXT.md")].join(
      "\n",
    );

    expect(publicDocumentation).not.toMatch(
      /builtin RunDef|built-in SDLC|harness evidence|open(?:s|ing)? (?:a )?PR|merge gate|audit command|\bbmad-pipeline (?:audit|iso|merge)\b|stage extension/iu,
    );
  });

  it("keeps source module documentation free of deleted policy vocabulary", () => {
    const sourceDocumentation = [
      "src/rundef/loader.ts",
      "src/rundef/compile.ts",
      "src/rundef/schema.ts",
      "src/rundef/types.ts",
      "src/cli-output.ts",
      "src/state/pipeline-state.ts",
      "src/events/debug-log.ts",
      "src/events/pipeline-event.ts",
      "src/core/stage-decision.ts",
      "src/core/budgets.ts",
      "src/actions/run-pipeline-action.ts",
    ]
      .map(readProjectFile)
      .join("\n");

    expect(sourceDocumentation).not.toMatch(
      /built-in(?:-vs-discovered| definition| definitions)|evidence|pull request|\bPR\b|merge|audit (?:artifact|logging|output|reason|status)|stage extension|current-run/iu,
    );
  });

  it("documents code stages without universal Pi or worktree claims", () => {
    const publicDocumentation = [
      "README.md",
      "CONTEXT.md",
      "skills/pi-bmad-pipeline-workflows/SKILL.md",
    ]
      .map(readProjectFile)
      .join("\n");

    expect(publicDocumentation).toContain("kind: code");
    expect(publicDocumentation).toContain("command:");
    expect(publicDocumentation).not.toMatch(
      /one (?:fresh, hermetic |hermetic )?Pi child per stage|each stage starts a fresh Pi process|ensure isolated story worktree|locks and isolated worktrees/iu,
    );
  });

  it("documents guarded current-version checkpoint backfill separately from legacy recovery", () => {
    const recoveryDocumentation = [
      "README.md",
      "src/core/CONTEXT.md",
      "skills/pi-bmad-pipeline-workflows/SKILL.md",
    ].map((path) => [path, readProjectFile(path)] as const);

    for (const [path, documentation] of recoveryDocumentation) {
      expect(documentation, path).toMatch(/current[- ]version/iu);
      expect(documentation, path).toMatch(/exact durable (?:review |passed[- ]review )?identity/iu);
      expect(documentation, path).toMatch(
        /zero[- ]stage|without re[- ]?running (?:pipeline )?stages/iu,
      );
      expect(documentation, path).toMatch(
        /backfill(?:s|ed|ing)? (?:the )?(?:missing )?review checkpoint|review checkpoint (?:is )?backfill/iu,
      );
      expect(documentation, path).toMatch(/legacy[\s\S]{0,160}reset[\s\S]{0,160}re[- ]?run/iu);
    }

    const skill = readProjectFile("skills/pi-bmad-pipeline-workflows/SKILL.md");
    expect(skill).toMatch(/troubleshooting/iu);
    expect(skill).toMatch(/concurrent default[- ]branch movement/iu);
    expect(skill).toMatch(/fail(?:s|ed)? closed/iu);
    expect(skill).toMatch(/(?:do not|never|no) hand[- ]edit/iu);
    expect(skill).toMatch(/documentation[- ]only[\s\S]{0,160}(?:unchanged|remains)/iu);
    expect(skill).toMatch(/non[- ]documentation drift[\s\S]{0,160}(?:unchanged|remains)/iu);
    expect(skill).toMatch(/serializ(?:e|ed|ing) (?:default[- ]branch )?landings/iu);
  });

  it("ships the claimed local-code executor module context", () => {
    const contextPath = resolve(projectRoot, "src/executors/code/CONTEXT.md");
    const moduleContext = existsSync(contextPath) ? readFileSync(contextPath, "utf8") : "";

    expect(moduleContext).toContain("Local");
    expect(moduleContext).toContain("shell");
    expect(moduleContext).toContain("at-least-once");
  });
});
