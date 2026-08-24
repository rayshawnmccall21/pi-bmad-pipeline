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

  it("documents deletion-aware Git observation in the actions context", () => {
    const path = "src/actions/CONTEXT.md";
    const documentation = readProjectFile(path);

    expect(documentation, path).toMatch(/tracked deletion[\s\S]{0,160}tombstone/iu);
    expect(documentation, path).toMatch(
      /tombstone[\s\S]{0,160}(?:distinct from|cannot alias)[\s\S]{0,80}(?:empty|zero[- ]byte)/iu,
    );
    expect(documentation, path).toMatch(/unique merge[- ]base[\s\S]{0,160}(?:fork|HEAD)/iu);
    expect(documentation, path).toMatch(
      /(?:authenticated|current|synchronized) default[- ](?:branch )?tip[\s\S]{0,160}(?:baseOid|receipt|trust anchor)/iu,
    );
    expect(documentation, path).toMatch(
      /default[- ]only[\s\S]{0,160}(?:exclude|never (?:read|tombstone)|not (?:read|tombstone))/iu,
    );
    expect(documentation, path).toMatch(
      /ENOENT[\s\S]{0,160}(?:stable|unchanged)[\s\S]{0,80}(?:absen|delet)/iu,
    );
    expect(documentation, path).toMatch(/(?:fail(?:s|ed)? closed|reject)[\s\S]{0,160}ambig/iu);
    expect(documentation, path).toMatch(/(?:fail(?:s|ed)? closed|reject)[\s\S]{0,160}race/iu);
    expect(documentation, path).toMatch(
      /(?:fail(?:s|ed)? closed|reject)[\s\S]{0,160}unrelated[\s\S]{0,40}(?:read )?error/iu,
    );
  });

  it("documents deletion and fork-skew recovery in the shipped skill", () => {
    const path = "skills/pi-bmad-pipeline-workflows/SKILL.md";
    const documentation = readProjectFile(path);

    expect(documentation, path).toMatch(
      /(?:genuine|tracked) (?:story )?deletion[\s\S]{0,160}tombstone[\s\S]{0,160}(?:empty|zero[- ]byte)/iu,
    );
    expect(documentation, path).toMatch(/unique merge[- ]base[\s\S]{0,160}(?:fork|HEAD)/iu);
    expect(documentation, path).toMatch(
      /default[- ]only[\s\S]{0,160}(?:exclude|never (?:read|tombstone)|not (?:read|tombstone))/iu,
    );
    expect(documentation, path).toMatch(
      /ENOENT[\s\S]{0,200}(?:resume|backfill|zero[- ]stage recovery)/iu,
    );
    expect(documentation, path).toMatch(/fail(?:s|ed)? closed[\s\S]{0,200}ambig/iu);
    expect(documentation, path).toMatch(/fail(?:s|ed)? closed[\s\S]{0,200}race/iu);
    expect(documentation, path).toMatch(
      /fail(?:s|ed)? closed[\s\S]{0,240}unrelated[\s\S]{0,40}(?:read )?error/iu,
    );
    expect(documentation, path).toMatch(
      /non[- ]documentation[\s\S]{0,160}deletion[\s\S]{0,120}invalidat[\s\S]{0,80}(?:unchanged|remains)|(?:unchanged|remains)[\s\S]{0,80}non[- ]documentation[\s\S]{0,160}deletion[\s\S]{0,120}invalidat/iu,
    );
    expect(documentation, path).toMatch(
      /exact[\s\S]{0,80}documentation[\s\S]{0,120}(?:path )?deletion[\s\S]{0,120}(?:allow|attest)/iu,
    );
    expect(documentation, path).toMatch(
      /executable[\s\S]{0,80}Markdown[\s\S]{0,120}(?:exclude|non[- ]documentation|cannot)/iu,
    );
  });

  it("documents compatibility-preserving tombstone framing in the security context", () => {
    const path = "src/security/CONTEXT.md";
    const documentation = readProjectFile(path);

    expect(documentation, path).toMatch(
      /transient[\s\S]{0,120}(?:present[\s\S]{0,40}absent|absent[\s\S]{0,40}present)[\s\S]{0,80}(?:snapshot|union)/iu,
    );
    expect(documentation, path).toMatch(
      /(?:tombstone|absent record)[\s\S]{0,160}(?:fram|marker|token)/iu,
    );
    expect(documentation, path).toMatch(
      /(?:tombstone|absent record)[\s\S]{0,160}(?:distinct from|cannot alias)[\s\S]{0,100}(?:empty|real (?:file )?(?:content|bytes))/iu,
    );
    expect(documentation, path).toMatch(
      /(?:legacy|all[- ]present)[\s\S]{0,160}(?:digest|fram)[\s\S]{0,100}(?:unchanged|compatible|preserv)/iu,
    );
    expect(documentation, path).toMatch(/durable[\s\S]{0,80}(?:v1|version 1)/iu);
    expect(documentation, path).toMatch(
      /(?:\{\s*paths\s*,\s*digest\s*\}|paths[\s\S]{0,40}digest)/iu,
    );
    expect(documentation, path).toMatch(
      /(?:key set|keys|schema)[\s\S]{0,100}(?:unchanged|no new)/iu,
    );
  });

  it("ships the claimed local-code executor module context", () => {
    const contextPath = resolve(projectRoot, "src/executors/code/CONTEXT.md");
    const moduleContext = existsSync(contextPath) ? readFileSync(contextPath, "utf8") : "";

    expect(moduleContext).toContain("Local");
    expect(moduleContext).toContain("shell");
    expect(moduleContext).toContain("at-least-once");
  });
});
