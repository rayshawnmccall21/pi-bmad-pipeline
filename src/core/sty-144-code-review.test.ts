import { describe, expect, it, vi } from "vitest";

import { createGitScopeAttestor } from "../actions/git-scope-attestor.js";
import { createFinalScopeReceipt } from "../security/final-scope-receipt.js";
import { getPipelineStateInvalidReason } from "../state/fs-state-validation.js";
import { createInitialPipelineState } from "../state/pipeline-state.js";
import { persistFinalScopeAttestation } from "./scope-attestation.js";

import type { CompiledAgentStage } from "../rundef/index.js";
import type {
  FinalScopeReceipt,
  PipelineState,
  ReviewScopeCheckpoint,
} from "../state/pipeline-state.js";

const T0 = "2026-08-18T00:00:00.000Z";
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const digest = (character: string): string => character.repeat(64);
const baseOid = "b".repeat(40);

const reviewStage: CompiledAgentStage = {
  id: "code-review",
  kind: "agent",
  workflow: "code-review",
  agent: "dev",
  index: 0,
  timeoutSeconds: 60,
  payloadGateName: "code-review",
  payloadGate: () => ({ passed: true }),
};

const checkpoint = (runId = "run-old"): ReviewScopeCheckpoint => ({
  version: 1,
  storyId: "STY-144",
  runId,
  runDefId: "review-docs",
  runDefDigest: digest("a"),
  branch: "sty-139/landing-integrity",
  baseOid,
  reviewed: { paths: ["src/app.ts"], digest: digest("c") },
  qualityGate: {
    stageId: "code-review",
    attempt: 1,
    status: "passed",
    finishedAt: T0,
  },
});

const receipt = (reviewCheckpoint = checkpoint()): FinalScopeReceipt => ({
  ...reviewCheckpoint,
  docs: { paths: [], digest: digest("d") },
  finalWorkingTreeDigest: digest("e"),
});

const passedState = (reviewCheckpoint?: ReviewScopeCheckpoint): PipelineState => {
  const initial = createInitialPipelineState({
    storyId: "STY-144",
    runDefId: "review-docs",
    runDefDigest: digest("a"),
    specFile: "story.md",
    stages: [reviewStage],
    model: "test-model",
    thinking: "high",
  });
  const originalStage = initial.stages["code-review"]!;
  return {
    ...initial,
    status: "running",
    stages: {
      "code-review": {
        ...originalStage,
        status: "passed",
        attempts: 1,
        startedAt: T0,
        finishedAt: T0,
        reason: "approved",
      },
    },
    ...(reviewCheckpoint === undefined ? {} : { reviewCheckpoint }),
  };
};

describe("STY-144 code review regressions", () => {
  it("invalidates review when a committed source byte changes with a clean worktree", async () => {
    let sourceRead = 0;
    const runGit = async (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "symbolic-ref") return "sty-139/landing-integrity\n";
      if (args[0] === "rev-parse" && args[1] === "main") return `${baseOid}\n`;
      if (args[0] === "status") return "";
      if (args[0] === "diff") return "src/app.ts\0";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return `${"f".repeat(40)}\n`;
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    };
    const attestScope = createGitScopeAttestor({
      runGit,
      readBytes: async () => encode(sourceRead++ === 0 ? "reviewed\n" : "changed commit\n"),
    });
    const identity = {
      projectRoot: "/repo",
      storyId: "STY-144",
      runId: "run-1",
      runDefId: "review-docs",
      runDefDigest: digest("a"),
      qualityGate: checkpoint("run-1").qualityGate,
    } as const;
    const reviewed = await attestScope({ phase: "review", ...identity });
    expect(reviewed.kind).toBe("review-checkpoint");
    if (reviewed.kind !== "review-checkpoint") return;

    const finalized = await attestScope({
      phase: "final",
      ...identity,
      reviewCheckpoint: reviewed.checkpoint,
    });

    expect(finalized).toMatchObject({ kind: "review-invalidated", changedPaths: ["src/app.ts"] });
  });

  it("does not classify shipped Markdown prompt and skill files as docs-only", async () => {
    let skillRead = 0;
    const skillPath = "skills/pi-bmad-pipeline-workflows/SKILL.md";
    const attestScope = createGitScopeAttestor({
      runGit: async (_projectRoot, args) => {
        if (args[0] === "symbolic-ref") return "feature\n";
        if (args[0] === "rev-parse") return `${baseOid}\n`;
        if (args[0] === "status") return ` M ${skillPath}\0`;
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      },
      readBytes: async () => encode(skillRead++ === 0 ? "reviewed skill\n" : "changed skill\n"),
    });
    const identity = {
      projectRoot: "/repo",
      storyId: "STY-144",
      runId: "run-1",
      runDefId: "review-docs",
      runDefDigest: digest("a"),
      qualityGate: checkpoint("run-1").qualityGate,
    } as const;
    const reviewed = await attestScope({ phase: "review", ...identity });
    expect(reviewed.kind).toBe("review-checkpoint");
    if (reviewed.kind !== "review-checkpoint") return;

    const finalized = await attestScope({
      phase: "final",
      ...identity,
      reviewCheckpoint: reviewed.checkpoint,
    });

    expect(finalized).toMatchObject({ kind: "review-invalidated", changedPaths: [skillPath] });
  });

  it("resumes final attestation with the durable checkpoint run identity", async () => {
    const durableCheckpoint = checkpoint("run-old");
    const context = {
      state: passedState(durableCheckpoint),
      request: {
        projectRoot: "/repo",
        storyId: "STY-144",
        runId: "run-new",
        stages: [reviewStage],
        attestScope: async () => ({
          kind: "final-receipt" as const,
          receipt: createFinalScopeReceipt({
            checkpoint: durableCheckpoint,
            comparison: {
              kind: "attested" as const,
              docs: { paths: [], digest: digest("d") },
              finalWorkingTreeDigest: digest("e"),
            },
          }),
        }),
        saveState: async () => undefined,
      },
    };

    await expect(persistFinalScopeAttestation(context)).resolves.toEqual({ kind: "attested" });
  });

  it("fails closed when a passed review stage has no durable review checkpoint", async () => {
    const attestScope = vi.fn(async () => ({
      kind: "final-receipt" as const,
      receipt: receipt(checkpoint("run-new")),
    }));
    const context = {
      state: passedState(),
      request: {
        projectRoot: "/repo",
        storyId: "STY-144",
        runId: "run-new",
        stages: [reviewStage],
        attestScope,
        saveState: async () => undefined,
      },
    };

    const result = await persistFinalScopeAttestation(context);

    expect(result).toMatchObject({ kind: "rejected" });
    expect(attestScope).not.toHaveBeenCalled();
  });

  it("rejects a persisted quality receipt that names no real passed stage attempt", () => {
    const durableCheckpoint = {
      ...checkpoint(),
      qualityGate: {
        stageId: "ghost-stage",
        attempt: 999,
        status: "passed" as const,
        finishedAt: T0,
      },
    };
    const candidate: PipelineState = {
      ...passedState(durableCheckpoint),
      status: "done",
      currentStage: null,
      finishedAt: T0,
      finalScopeReceipt: receipt(durableCheckpoint),
    };

    expect(getPipelineStateInvalidReason(candidate)).toMatch(/quality|stage|attempt/u);
  });

  it("re-attests an interrupted preterminal receipt before allowing terminal success", async () => {
    const durableCheckpoint = checkpoint("run-old");
    const attestScope = vi.fn(async () => ({
      kind: "review-invalidated" as const,
      changedPaths: ["src/app.ts"],
    }));
    const context = {
      state: {
        ...passedState(durableCheckpoint),
        finalScopeReceipt: receipt(durableCheckpoint),
      },
      request: {
        projectRoot: "/repo",
        storyId: "STY-144",
        runId: "run-new",
        stages: [reviewStage],
        attestScope,
        saveState: async () => undefined,
      },
    };

    await expect(persistFinalScopeAttestation(context)).resolves.toEqual({
      kind: "review-invalidated",
      changedPaths: ["src/app.ts"],
    });
    expect(attestScope).toHaveBeenCalledOnce();
    expect(attestScope).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "final", runId: durableCheckpoint.runId }),
    );
  });
});
