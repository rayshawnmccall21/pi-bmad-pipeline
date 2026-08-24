import { describe, expect, it, vi } from "vitest";

import { createGitScopeAttestor } from "../actions/git-scope-attestor.js";
import { createFinalScopeReceipt } from "../security/final-scope-receipt.js";
import { getPipelineStateInvalidReason } from "../state/fs-state-validation.js";
import { createInitialPipelineState } from "../state/pipeline-state.js";
import { persistFinalScopeAttestation } from "./scope-attestation.js";

import type { ScopeAttestationResult, ScopeAttestor } from "./scope-attestation.js";

import type { CompiledAgentStage } from "../rundef/index.js";
import type {
  FinalScopeReceipt,
  PipelineState,
  QualityGateReceipt,
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

const T1 = "2026-08-18T12:34:56.789Z";

const passedAttemptHistory = (attempts: number, finishedAt: string) =>
  Array.from({ length: attempts }, (_, attemptIndex) => ({
    attempt: attemptIndex + 1,
    status: "passed" as const,
    startedAt: T0,
    finishedAt: attemptIndex + 1 === attempts ? finishedAt : T0,
    durationMs: 1,
    exitCode: 0,
    reason: "approved",
  }));

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
        history: passedAttemptHistory(1, T0),
        reason: "approved",
      },
    },
    ...(reviewCheckpoint === undefined ? {} : { reviewCheckpoint }),
  };
};

const distinctivePassedState = (): PipelineState => {
  const state = passedState();
  return {
    ...state,
    stages: {
      "code-review": {
        ...state.stages["code-review"]!,
        attempts: 7,
        finishedAt: T1,
        history: passedAttemptHistory(7, T1),
      },
    },
  };
};

const checkpointFor = (
  qualityGate: QualityGateReceipt,
  runId = "run-new",
): ReviewScopeCheckpoint => ({
  ...checkpoint(runId),
  qualityGate,
});

const backfillContext = (
  attestScope: ScopeAttestor,
  state: PipelineState = distinctivePassedState(),
  stages: readonly CompiledAgentStage[] = [reviewStage],
) => ({
  state,
  request: {
    projectRoot: "/repo",
    storyId: "STY-144",
    runId: "run-new",
    stages,
    attestScope,
    saveState: vi.fn(async (stateToSave: PipelineState) => {
      void stateToSave;
    }),
  },
});

describe("STY-144 code review regressions", () => {
  it("invalidates review when a committed source byte changes with a clean worktree", async () => {
    let sourceRead = 0;
    const runGit = async (_projectRoot: string, args: readonly string[]) => {
      const command = args.join(" ");
      if (command === "symbolic-ref --quiet --short HEAD") return "sty-139/landing-integrity\n";
      if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
        return "refs/remotes/origin/main\n";
      }
      if (
        command === "rev-parse --verify refs/heads/main" ||
        command === "rev-parse --verify refs/remotes/origin/main"
      ) {
        return `${baseOid}\n`;
      }
      if (args[0] === "status") return "";
      if (args[0] === "diff") return "src/app.ts\0";
      if (command === "rev-parse HEAD") return `${"f".repeat(40)}\n`;
      throw new Error(`Unexpected git command: ${command}`);
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
        const command = args.join(" ");
        if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
        if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
          return "refs/remotes/origin/main\n";
        }
        if (
          command === "rev-parse --verify refs/heads/main" ||
          command === "rev-parse --verify refs/remotes/origin/main" ||
          command === "rev-parse HEAD"
        ) {
          return `${baseOid}\n`;
        }
        if (args[0] === "status") return ` M ${skillPath}\0`;
        throw new Error(`Unexpected git command: ${command}`);
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

  it("backfills from the exact durable review identity before final attestation", async () => {
    const attestScope = vi.fn<ScopeAttestor>(async (request) => {
      if (request.phase === "review") {
        return {
          kind: "review-checkpoint",
          checkpoint: checkpointFor(request.qualityGate),
        };
      }
      if (request.reviewCheckpoint === undefined) {
        throw new Error("final review checkpoint is required");
      }
      return {
        kind: "final-receipt",
        receipt: receipt(request.reviewCheckpoint),
      };
    });
    const context = backfillContext(attestScope);
    expect(getPipelineStateInvalidReason(context.state)).toBeUndefined();

    await expect(persistFinalScopeAttestation(context)).resolves.toEqual({ kind: "attested" });

    expect(attestScope.mock.calls.map(([request]) => request.phase)).toEqual(["review", "final"]);
    expect(attestScope.mock.calls.at(0)?.[0]).toEqual({
      phase: "review",
      projectRoot: "/repo",
      storyId: "STY-144",
      runId: "run-new",
      runDefId: "review-docs",
      runDefDigest: digest("a"),
      qualityGate: {
        stageId: "code-review",
        attempt: 7,
        status: "passed",
        finishedAt: T1,
      },
    });
    expect(context.request.saveState).toHaveBeenCalledTimes(2);
    const checkpointState = context.request.saveState.mock.calls.at(0)?.[0];
    const receiptState = context.request.saveState.mock.calls.at(1)?.[0];
    expect(checkpointState?.reviewCheckpoint?.qualityGate).toEqual({
      stageId: "code-review",
      attempt: 7,
      status: "passed",
      finishedAt: T1,
    });
    expect(checkpointState?.finalScopeReceipt).toBeUndefined();
    expect(receiptState?.finalScopeReceipt).toBeDefined();
    expect(
      context.request.saveState.mock.calls.every(
        ([savedState]) => getPipelineStateInvalidReason(savedState) === undefined,
      ),
    ).toBe(true);
  });

  it.each([
    ["zero attempts", { attempts: 0 }],
    ["missing finishedAt", { finishedAt: null }],
  ])("rejects %s before invoking the attestor", async (_name, stageChanges) => {
    const state = distinctivePassedState();
    const malformedState: PipelineState = {
      ...state,
      stages: {
        "code-review": { ...state.stages["code-review"]!, ...stageChanges },
      },
    };
    const attestScope = vi.fn<ScopeAttestor>();

    await expect(
      persistFinalScopeAttestation(backfillContext(attestScope, malformedState)),
    ).resolves.toMatchObject({ kind: "rejected" });
    expect(attestScope).not.toHaveBeenCalled();
  });

  it("rejects a missing durable review stage before invoking the attestor", async () => {
    const state: PipelineState = { ...distinctivePassedState(), stages: {} };
    const attestScope = vi.fn<ScopeAttestor>();

    await expect(
      persistFinalScopeAttestation(backfillContext(attestScope, state)),
    ).resolves.toMatchObject({ kind: "rejected" });
    expect(attestScope).not.toHaveBeenCalled();
  });

  it("rejects multiple passed compiled review stages before invoking the attestor", async () => {
    const state = distinctivePassedState();
    const secondaryReview = { ...reviewStage, id: "code-review-secondary", index: 1 };
    const ambiguousState: PipelineState = {
      ...state,
      stages: {
        ...state.stages,
        "code-review-secondary": {
          ...state.stages["code-review"]!,
          id: "code-review-secondary",
        },
      },
    };
    const attestScope = vi.fn<ScopeAttestor>();

    await expect(
      persistFinalScopeAttestation(
        backfillContext(attestScope, ambiguousState, [reviewStage, secondaryReview]),
      ),
    ).resolves.toMatchObject({ kind: "rejected" });
    expect(attestScope).not.toHaveBeenCalled();
  });

  it.each([
    ["typed rejection", async () => ({ kind: "rejected", reason: "ambiguous Git" })],
    [
      "throw",
      async () => {
        throw new Error("Git failed");
      },
    ],
    [
      "wrong result kind",
      async () => ({ kind: "final-receipt", receipt: receipt(checkpoint("run-new")) }),
    ],
    [
      "mismatched run identity",
      async (qualityGate: QualityGateReceipt) => ({
        kind: "review-checkpoint",
        checkpoint: checkpointFor(qualityGate, "wrong-run"),
      }),
    ],
  ] as const)(
    "%s during review backfill never invokes final attestation",
    async (_name, resultFor) => {
      const attestScope = vi.fn<ScopeAttestor>(
        async (request) => resultFor(request.qualityGate) as Promise<ScopeAttestationResult>,
      );
      const context = backfillContext(attestScope);

      await expect(persistFinalScopeAttestation(context)).resolves.toMatchObject({
        kind: "rejected",
      });
      expect(attestScope).toHaveBeenCalledOnce();
      expect(attestScope.mock.calls.at(0)?.[0]).toMatchObject({ phase: "review" });
      expect(context.request.saveState).not.toHaveBeenCalled();
    },
  );

  it("normalizes non-JSON attestor throws during review backfill", async () => {
    const attestScope = vi.fn<ScopeAttestor>(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- adversarial unknown throw.
      throw 1n;
    });
    const context = backfillContext(attestScope);

    await expect(persistFinalScopeAttestation(context)).resolves.toMatchObject({
      kind: "rejected",
    });
    expect(context.state.reviewCheckpoint).toBeUndefined();
    expect(context.request.saveState).not.toHaveBeenCalled();
  });

  it("normalizes non-JSON persistence throws during review backfill", async () => {
    const attestScope = vi.fn<ScopeAttestor>(async (request) => {
      if (request.phase !== "review") {
        throw new Error("final attestation must not run");
      }
      return {
        kind: "review-checkpoint",
        checkpoint: checkpointFor(request.qualityGate),
      };
    });
    const context = backfillContext(attestScope);
    context.request.saveState.mockImplementationOnce(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- adversarial unknown throw.
      throw 1n;
    });

    await expect(persistFinalScopeAttestation(context)).resolves.toMatchObject({
      kind: "rejected",
    });
    expect(attestScope).toHaveBeenCalledOnce();
    expect(context.state.reviewCheckpoint).toBeUndefined();
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
