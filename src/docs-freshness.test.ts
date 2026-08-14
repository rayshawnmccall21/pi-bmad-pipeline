import { readFileSync } from "node:fs";
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
});
