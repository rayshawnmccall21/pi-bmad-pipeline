import { describe, expect, it, vi } from "vitest";

import {
  BMAD_PIPELINE_MODEL_ENV_VAR,
  BMAD_PIPELINE_PI_BIN_ENV_VAR,
  BMAD_PIPELINE_THINKING_ENV_VAR,
  INTERNAL_ERROR_CODE,
  LOCK_HELD_ERROR_CODE,
  defaultRunPipelineActionDeps,
  runPipelineAction,
  type RunPipelineActionDeps,
  type RunPipelineActionRequest,
} from "./index.js";
import {
  runPipelineStages,
  type RunPipelineStagesRequest,
  type RunPipelineStagesResult,
  type ScopeAttestor,
} from "../core/index.js";
import {
  StageExecutorDispatcher,
  type StageExecutionRequest,
  type WorkflowExecutor,
} from "../executors/index.js";
import { registerBmadPayloadGates } from "../gates/index.js";
import { resolveModelConfig } from "../model/index.js";
import {
  computeRunDefDigest,
  payloadGateRegistry,
  selectAndCompileRunDef,
  type CompiledStageDef,
  type RunDef,
} from "../rundef/index.js";
import {
  createCanonicalRepositoryScope,
  createFinalScopeReceipt,
  createReviewScopeCheckpoint,
} from "../security/final-scope-receipt.js";
import { getPipelineStateInvalidReason } from "../state/fs-state-validation.js";
import {
  acquireDispatchLock,
  createInitialPipelineState,
  loadPipelineState,
  reconcilePipelineState,
  savePipelineState,
  type DispatchLock,
  type FinalScopeReceipt,
  type PipelineState,
  type ReviewScopeCheckpoint,
  type StageState,
} from "../state/index.js";

const timestamp = "2026-08-05T00:00:00.000Z";
const stages: readonly CompiledStageDef[] = [
  { id: "dev", kind: "agent", workflow: "dev-story", agent: "dev", index: 0, timeoutSeconds: 60 },
];

const doneFsm = async (request: RunPipelineStagesRequest): Promise<RunPipelineStagesResult> => {
  const stage = request.stages[0];
  if (stage === undefined) throw new Error("missing fixture stage");
  request.observer?.onStageStarted?.({ stage, attempt: 1 });
  request.observer?.onStageFinished?.({
    stage,
    attempt: 1,
    decision: { stageId: stage.id, kind: "passed", passed: true, reason: "ok" },
    route: { action: "complete", fromStageId: stage.id, regressions: 0, reason: "done" },
    execution: { output: { payload: {} }, exitCode: 0, durationMs: 5 },
  });
  const state = { ...request.state, status: "done" as const, finishedAt: timestamp };
  await request.saveState(state);
  return { state, status: "done", stagesRun: ["dev"], regressions: 0 };
};

interface Harness {
  readonly request: RunPipelineActionRequest;
  readonly calls: string[];
  readonly saves: PipelineState[];
  readonly events: Record<string, unknown>[];
}

const createHarness = (
  overrides: {
    readonly lockHeld?: boolean;
    readonly loaded?: PipelineState;
    readonly request?: Partial<RunPipelineActionRequest>;
    readonly deps?: Partial<RunPipelineActionDeps>;
  } = {},
): Harness => {
  const calls: string[] = [];
  const saves: PipelineState[] = [];
  const events: Record<string, unknown>[] = [];
  const lock: DispatchLock = {
    storyId: "SH-1",
    path: "/lock",
    info: { pid: 1, runId: "run-1", startedAt: timestamp },
    release: async () => {
      calls.push("release");
    },
  };
  const executor: WorkflowExecutor = {
    id: "fake",
    execute: () => Promise.reject(new Error("unused")),
  };
  const deps: Partial<RunPipelineActionDeps> = {
    acquireLock: async () => {
      calls.push("lock");
      return overrides.lockHeld ? undefined : lock;
    },
    loadState: async () => {
      calls.push("load");
      return overrides.loaded;
    },
    saveState: async (_root, state) => {
      calls.push("save");
      saves.push(state);
      return "/state.json";
    },
    reconcileState: (request) => reconcilePipelineState(request),

    registerGates: () => {
      calls.push("gates");
      return { registered: ["e2e-verify", "code-review"] };
    },
    selectAndCompile: async (_root, id, options) => {
      calls.push(`select:${String(options?.registry === payloadGateRegistry)}`);
      return {
        id,
        source: "discovered",
        path: "/root/.pi/bmad/pipelines/sdlc.yaml",
        runDef: { id, stages: [] },
        stages,
      };
    },
    resolveModel: (request) => {
      calls.push("model");
      return resolveModelConfig(request);
    },
    createExecutor: () => {
      calls.push("executor");
      return executor;
    },
    attestScope: vi.fn<ScopeAttestor>(),
    runStages: async (request) => {
      calls.push("fsm");
      return doneFsm(request);
    },
    createRunId: () => "run-1",
    ...overrides.deps,
  };
  const request: RunPipelineActionRequest = {
    rundefId: "sdlc",
    storyId: "SH-1",
    specFile: "spec.md",
    projectRoot: "/root",
    now: () => new Date(timestamp),
    deps,
    sink: { write: (line) => events.push(JSON.parse(line) as Record<string, unknown>) },
    ...overrides.request,
  };
  return { request, calls, saves, events };
};

describe("runPipelineAction", () => {
  it("runs lock through durable FSM result with no policy effects", async () => {
    const harness = createHarness();
    const result = await runPipelineAction(harness.request);
    expect(result).toMatchObject({ status: "passed", stagesRun: ["dev"] });
    expect(harness.calls).toEqual([
      "lock",
      "load",
      "gates",
      "select:true",
      "model",
      "save",
      "executor",
      "fsm",
      "save",
      "release",
    ]);
    expect(harness.events.map((event) => event["event"])).toEqual([
      "run.started",
      "stage.started",
      "stage.finished",
      "result",
    ]);
    expect(harness.events.filter((event) => event["event"] === "result")).toHaveLength(1);
    expect(Object.keys(harness.request.deps ?? {})).not.toEqual(
      expect.arrayContaining(["runEvidence", "openPullRequest", "generateAuditReport"]),
    );
  });

  it("wires the injected scope attestor and lock run identity into the FSM", async () => {
    const attestScope = vi.fn<ScopeAttestor>();
    const runStages = vi.fn(doneFsm);
    const harness = createHarness({ deps: { attestScope, runStages } });

    await runPipelineAction(harness.request);

    expect(runStages).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        attestScope,
      }),
    );
    expect(attestScope).not.toHaveBeenCalled();
  });

  it("accepts an empty specFile and records it in the first saved state", async () => {
    const harness = createHarness({ request: { specFile: "" } });
    const result = await runPipelineAction(harness.request);
    expect(result).toMatchObject({ status: "passed", stagesRun: ["dev"] });
    expect(harness.calls[0]).toBe("lock");
    expect(harness.saves[0]?.specFile).toBe("");
  });

  it("fails closed on lock contention without preparing state", async () => {
    const harness = createHarness({ lockHeld: true });
    expect(await runPipelineAction(harness.request)).toMatchObject({
      status: "needs-attention",
      error: expect.stringContaining("held"),
    });
    expect(harness.calls).toEqual(["lock"]);
    expect(harness.events.map((event) => event["event"])).toEqual(["error", "result"]);
    expect(harness.events[0]).toMatchObject({ code: LOCK_HELD_ERROR_CODE });
  });

  it("releases the lock and emits a coded error when a step throws", async () => {
    const harness = createHarness({
      deps: {
        runStages: async () => {
          throw Object.assign(new Error("bad"), { code: "coded" });
        },
      },
    });
    expect(await runPipelineAction(harness.request)).toMatchObject({
      status: "needs-attention",
      error: "bad",
    });
    expect(harness.calls.at(-1)).toBe("release");
    expect(harness.events).toContainEqual(
      expect.objectContaining({ event: "error", code: "coded" }),
    );
  });

  it("uses internal-error for uncoded throws", async () => {
    const harness = createHarness({
      deps: {
        runStages: async () => {
          throw new Error("bad");
        },
      },
    });
    await runPipelineAction(harness.request);
    expect(harness.events).toContainEqual(
      expect.objectContaining({ event: "error", code: INTERNAL_ERROR_CODE }),
    );
  });

  it("settles a non-done FSM outcome without policy effects", async () => {
    const harness = createHarness({
      deps: {
        runStages: async (request) => ({
          state: { ...request.state, status: "failed" },
          status: "failed",
          stagesRun: ["dev"],
          regressions: 0,
          failure: { code: "stage-failed", stageId: "dev", reason: "stage failed" },
        }),
      },
    });

    await expect(runPipelineAction(harness.request)).resolves.toMatchObject({
      status: "failed",
      error: "stage failed",
    });
    expect(harness.events.filter((event) => event["event"] === "result")).toHaveLength(1);
    expect(harness.calls.at(-1)).toBe("release");
  });

  it("uses environment-only model and thinking candidates", async () => {
    const createExecutor = vi.fn((): WorkflowExecutor => ({
      id: "env-executor",
      execute: () => Promise.reject(new Error("unused")),
    }));
    const harness = createHarness({
      request: {
        env: { BMAD_PIPELINE_MODEL: "env-model", BMAD_PIPELINE_THINKING: "high" },
      },
      deps: { createExecutor },
    });

    await runPipelineAction(harness.request);

    expect(createExecutor).toHaveBeenCalledWith({ model: "env-model", thinking: "high" });
  });

  it("forwards the environment pi bin override to executor construction", async () => {
    const createExecutor = vi.fn((): WorkflowExecutor => ({
      id: "env-executor",
      execute: () => Promise.reject(new Error("unused")),
    }));
    const harness = createHarness({
      request: {
        env: {
          [BMAD_PIPELINE_MODEL_ENV_VAR]: "env-model",
          [BMAD_PIPELINE_THINKING_ENV_VAR]: "high",
          [BMAD_PIPELINE_PI_BIN_ENV_VAR]: "/stub/pi",
        },
      },
      deps: { createExecutor },
    });

    await runPipelineAction(harness.request);

    expect(createExecutor).toHaveBeenCalledWith({
      model: "env-model",
      thinking: "high",
      piBin: "/stub/pi",
    });
  });

  it("omits the pi bin override when the environment value is blank", async () => {
    const createExecutor = vi.fn((): WorkflowExecutor => ({
      id: "env-executor",
      execute: () => Promise.reject(new Error("unused")),
    }));
    const harness = createHarness({
      request: { env: { [BMAD_PIPELINE_PI_BIN_ENV_VAR]: "   " } },
      deps: { createExecutor },
    });

    await runPipelineAction(harness.request);

    expect(createExecutor).toHaveBeenCalledWith({
      model: expect.any(String),
      thinking: expect.any(String),
    });
  });

  it("resolves explicit model over environment and forwards budgets and signal", async () => {
    const signal = new AbortController().signal;
    const runStages = vi.fn(doneFsm);
    const harness = createHarness({
      request: {
        model: "explicit",
        thinking: "high",
        env: { [BMAD_PIPELINE_MODEL_ENV_VAR]: "env" },
        maxRegressions: 2,
        runBudget: { maxTokens: 5 },
        signal,
      },
      deps: { runStages },
    });
    await runPipelineAction(harness.request);
    expect(runStages).toHaveBeenCalledWith(
      expect.objectContaining({ maxRegressions: 2, runBudget: { maxTokens: 5 }, signal }),
    );
  });

  it("reconciles loaded state and saves only changed repairs", async () => {
    const initial = createInitialPipelineState({
      storyId: "SH-1",
      runDefId: "sdlc",
      runDefDigest: computeRunDefDigest({ id: "sdlc", stages: [] }),
      specFile: "spec.md",
      stages,
      model: "gpt-5.5-pro",
      thinking: "medium",
      startedAt: timestamp,
    });
    const harness = createHarness({
      loaded: {
        ...initial,
        status: "running",
        currentStage: "dev",
        stages: { dev: { ...initial.stages["dev"]!, status: "running" } },
      },
    });
    await runPipelineAction(harness.request);
    expect(harness.saves.length).toBeGreaterThanOrEqual(2);
  });

  it("resumes durable state when loaded state matches cleanly", async () => {
    const boundState = createInitialPipelineState({
      storyId: "SH-1",
      runDefId: "sdlc",
      runDefDigest: computeRunDefDigest({ id: "sdlc", stages: [] }),
      specFile: "spec.md",
      stages,
      model: "gpt-5.5-pro",
      thinking: "medium",
    });
    const runStages = vi.fn(doneFsm);
    const harness = createHarness({
      loaded: boundState,
      deps: { runStages },
    });

    await expect(runPipelineAction(harness.request)).resolves.toMatchObject({ status: "passed" });
    expect(runStages).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: "/root" }));
  });

  it("fails closed when YAML changes but reuses the same stage ids", async () => {
    const changedRunDefState = createInitialPipelineState({
      storyId: "SH-1",
      runDefId: "sdlc",
      runDefDigest: computeRunDefDigest({
        id: "sdlc",
        stages: [{ id: "dev", kind: "agent", workflow: "older-workflow", agent: "dev" }],
      }),
      specFile: "spec.md",
      stages,
      model: "gpt-5.5-pro",
      thinking: "medium",
      startedAt: timestamp,
    });
    const runStages = vi.fn(doneFsm);
    const harness = createHarness({ loaded: changedRunDefState, deps: { runStages } });

    const actionResult = await runPipelineAction(harness.request);

    expect(actionResult).toMatchObject({
      status: "needs-attention",
      error: expect.stringContaining("RunDef identity"),
    });
    expect(runStages).not.toHaveBeenCalled();
  });

  it("blocks code command and args changes before execution", async () => {
    const previousRunDef = {
      id: "sdlc",
      stages: [{ id: "check", kind: "code" as const, command: "npm", args: ["run", "old"] }],
    };
    const activeRunDef = {
      id: "sdlc",
      stages: [{ id: "check", kind: "code" as const, command: "npm", args: ["run", "check"] }],
    };
    const codeStages: readonly CompiledStageDef[] = [
      {
        id: "check",
        kind: "code",
        command: "npm",
        args: ["run", "check"],
        index: 0,
        timeoutSeconds: 60,
      },
    ];
    const loaded = createInitialPipelineState({
      storyId: "SH-1",
      runDefId: "sdlc",
      runDefDigest: computeRunDefDigest(previousRunDef),
      specFile: "spec.md",
      stages: codeStages,
      model: "gpt-5.5-pro",
      thinking: "medium",
    });
    const runStages = vi.fn(doneFsm);
    const harness = createHarness({
      loaded,
      deps: {
        selectAndCompile: async () => ({
          id: "sdlc",
          source: "discovered",
          path: "/root/.pi/bmad/pipelines/sdlc.yaml",
          runDef: activeRunDef,
          stages: codeStages,
        }),
        runStages,
      },
    });

    const result = await runPipelineAction(harness.request);

    expect(result.status).toBe("needs-attention");
    expect(runStages).not.toHaveBeenCalled();
  });

  it("does not save clean loaded state before the FSM", async () => {
    const boundState = createInitialPipelineState({
      storyId: "SH-1",
      runDefId: "sdlc",
      runDefDigest: computeRunDefDigest({ id: "sdlc", stages: [] }),
      specFile: "spec.md",
      stages,
      model: "gpt-5.5-pro",
      thinking: "medium",
    });
    const harness = createHarness({ loaded: boundState });

    await runPipelineAction(harness.request);

    expect(harness.calls.filter((callName) => callName === "save")).toHaveLength(1);
  });

  it.each([
    ["storyId", "../bad"],
    ["rundefId", " "],
    ["projectRoot", " "],
  ] as const)("rejects invalid %s before locking", async (field, invalidValue) => {
    const harness = createHarness({ request: { [field]: invalidValue } });
    await expect(runPipelineAction(harness.request)).rejects.toBeInstanceOf(RangeError);
    expect(harness.calls).toEqual([]);
  });

  it("creates unique default run ids", () => {
    expect(defaultRunPipelineActionDeps.createRunId()).not.toBe(
      defaultRunPipelineActionDeps.createRunId(),
    );
  });

  it("wires real core defaults and creates an exhaustive stage dispatcher", () => {
    expect(defaultRunPipelineActionDeps.acquireLock).toBe(acquireDispatchLock);
    expect(defaultRunPipelineActionDeps.loadState).toBe(loadPipelineState);
    expect(defaultRunPipelineActionDeps.saveState).toBe(savePipelineState);
    expect(defaultRunPipelineActionDeps.registerGates).toBe(registerBmadPayloadGates);
    expect(defaultRunPipelineActionDeps.selectAndCompile).toBe(selectAndCompileRunDef);
    expect(defaultRunPipelineActionDeps.runStages).toBe(runPipelineStages);
    expect(defaultRunPipelineActionDeps.attestScope).toBeTypeOf("function");
    expect(defaultRunPipelineActionDeps.readGitHead).toBeTypeOf("function");
    expect(
      defaultRunPipelineActionDeps.createExecutor({ model: "m", thinking: "medium" }),
    ).toBeInstanceOf(StageExecutorDispatcher);
  });

  it("forwards a normalized terminalRecovery into the locked FSM", async () => {
    const runStages = vi.fn(doneFsm);
    const harness = createHarness({
      loaded: recoveryDoneState(),
      request: {
        terminalRecovery: {
          kind: "supersede-contract-invalid-candidate",
          expectedReceiptRunId: "ebeb8c17-0cb7-44dc-ae83-eabc4ac060eb",
          reason: "  Contract defect: delivered payload counters diverge.  ",
        },
      },
      deps: {
        runStages,
        selectAndCompile: async () => ({
          id: RECOVERY_RUNDEF_ID,
          source: "discovered",
          path: "/root/.pi/bmad/pipelines/sdlc.yaml",
          runDef: RECOVERY_RUNDEF,
          stages: recoveryStages(),
        }),
      },
    });

    await runPipelineAction(harness.request);

    expect(runStages).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalRecovery: {
          kind: "supersede-contract-invalid-candidate",
          expectedReceiptRunId: "ebeb8c17-0cb7-44dc-ae83-eabc4ac060eb",
          reason: "Contract defect: delivered payload counters diverge.",
        },
        readTerminalCorrectionHead: expect.any(Function),
      }),
    );
  });

  it("redacts credential material from the normalized recovery reason", async () => {
    const runStages = vi.fn(doneFsm);
    const harness = createHarness({
      loaded: recoveryDoneState(),
      request: {
        terminalRecovery: {
          kind: "supersede-contract-invalid-candidate",
          expectedReceiptRunId: "run-1",
          reason: "Bearer sk-secret-token-1234567890 leaks into landing payloads",
        },
      },
      deps: {
        runStages,
        selectAndCompile: async () => ({
          id: RECOVERY_RUNDEF_ID,
          source: "discovered",
          path: "/root/.pi/bmad/pipelines/sdlc.yaml",
          runDef: RECOVERY_RUNDEF,
          stages: recoveryStages(),
        }),
      },
    });

    await runPipelineAction(harness.request);

    expect(runStages).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalRecovery: expect.objectContaining({
          reason: expect.not.stringContaining("sk-secret-token-1234567890"),
        }),
      }),
    );
  });

  it.each([
    [
      "blank reason",
      {
        kind: "supersede-contract-invalid-candidate",
        expectedReceiptRunId: "run-1",
        reason: "   ",
      },
    ],
    [
      "oversized reason",
      {
        kind: "supersede-contract-invalid-candidate",
        expectedReceiptRunId: "run-1",
        reason: "x".repeat(4096),
      },
    ],
    [
      "blank expected run id",
      {
        kind: "supersede-contract-invalid-candidate",
        expectedReceiptRunId: "  ",
        reason: "defect",
      },
    ],
  ] as const)(
    "rejects a terminalRecovery with %s before locking",
    async (_name, terminalRecovery) => {
      const harness = createHarness({ request: { terminalRecovery } });

      await expect(runPipelineAction(harness.request)).rejects.toBeInstanceOf(RangeError);
      expect(harness.calls).toEqual([]);
    },
  );

  it("rejects an untyped unsupported recovery kind before locking or effects", async () => {
    const harness = createHarness({
      request: {
        terminalRecovery: {
          kind: "some-other-kind",
          expectedReceiptRunId: "run-1",
          reason: "defect",
        } as never,
      },
    });

    await expect(runPipelineAction(harness.request)).rejects.toBeInstanceOf(RangeError);
    expect(harness.calls).toEqual([]);
  });

  it("rejects an oversized untyped expected receipt run id before locking or effects", async () => {
    const harness = createHarness({
      request: {
        terminalRecovery: {
          kind: "supersede-contract-invalid-candidate",
          expectedReceiptRunId: "x".repeat(101),
          reason: "defect",
        } as never,
      },
    });

    await expect(runPipelineAction(harness.request)).rejects.toBeInstanceOf(RangeError);
    expect(harness.calls).toEqual([]);
  });
});

const RECOVERY_RUNDEF_ID = "sdlc";
const RECOVERY_RUNDEF: RunDef = {
  id: RECOVERY_RUNDEF_ID,
  stages: [
    { id: "dev-story", kind: "agent", workflow: "dev-story", agent: "dev", timeout: 2400 },
    {
      id: "code-review",
      kind: "agent",
      workflow: "code-review",
      agent: "dev",
      gate: "code-review",
      onFail: "dev-story",
      timeout: 2400,
    },
    { id: "docs", kind: "agent", workflow: "docs", agent: "architect", timeout: 2400 },
  ],
};
const RECOVERY_RUNDEF_DIGEST = computeRunDefDigest(RECOVERY_RUNDEF);
const RECOVERY_BASE_OID = "a".repeat(40);
const SEED_RECEIPT_RUN_ID = "seed-run-1";

const recoveryStages = (): readonly CompiledStageDef[] => [
  {
    id: "dev-story",
    kind: "agent",
    workflow: "dev-story",
    agent: "dev",
    index: 0,
    timeoutSeconds: 60,
  },
  {
    id: "code-review",
    kind: "agent",
    workflow: "code-review",
    agent: "dev",
    index: 1,
    timeoutSeconds: 60,
    payloadGate: okGate,
    payloadGateName: "code-review",
    onFail: "dev-story",
  },
  { id: "docs", kind: "agent", workflow: "docs", agent: "architect", index: 2, timeoutSeconds: 60 },
];

const okGate = (payload: Record<string, unknown>) =>
  payload["ok"] === true ? { passed: true } : { passed: false, reason: "gate rejected payload" };

const recoveryCheckpoint = (): ReviewScopeCheckpoint =>
  createReviewScopeCheckpoint({
    storyId: "SH-1",
    runId: SEED_RECEIPT_RUN_ID,
    runDefId: RECOVERY_RUNDEF_ID,
    runDefDigest: RECOVERY_RUNDEF_DIGEST,
    branch: "main",
    baseOid: RECOVERY_BASE_OID,
    reviewedFiles: [{ path: "src/app.ts", bytes: new Uint8Array() }],
    qualityGate: {
      stageId: "code-review",
      attempt: 1,
      status: "passed",
      finishedAt: timestamp,
    },
  });

const recoveryReceipt = (): FinalScopeReceipt =>
  createFinalScopeReceipt({
    checkpoint: recoveryCheckpoint(),
    comparison: {
      kind: "attested",
      docs: createCanonicalRepositoryScope([{ path: "README.md", bytes: new Uint8Array() }]),
      finalWorkingTreeDigest: createCanonicalRepositoryScope([
        { path: "src/app.ts", bytes: new Uint8Array() },
        { path: "README.md", bytes: new Uint8Array() },
      ]).digest,
    },
  });

const passedRecoveryStage = (id: string): StageState =>
  Object.freeze({
    id,
    status: "passed",
    attempts: 1,
    startedAt: timestamp,
    finishedAt: timestamp,
    history: Object.freeze([
      Object.freeze({
        attempt: 1,
        status: "passed",
        startedAt: timestamp,
        finishedAt: timestamp,
        durationMs: 1,
        exitCode: 0,
        reason: "prior pass",
      }),
    ]),
  });

const recoveryDoneState = (overrides: Partial<PipelineState> = {}): PipelineState =>
  Object.freeze({
    storyId: "SH-1",
    runDefId: RECOVERY_RUNDEF_ID,
    runDefDigest: RECOVERY_RUNDEF_DIGEST,
    specFile: "spec.md",
    runnerFeatureVersion: 2,
    status: "done",
    currentStage: null,
    stages: Object.freeze({
      "dev-story": passedRecoveryStage("dev-story"),
      "code-review": passedRecoveryStage("code-review"),
      docs: passedRecoveryStage("docs"),
    }),
    regressions: 0,
    startedAt: timestamp,
    finishedAt: timestamp,
    model: "gpt-5.5-pro",
    thinking: "medium",
    economics: Object.freeze({ tokens: 0, dollars: 0 }),
    reviewCheckpoint: recoveryCheckpoint(),
    finalScopeReceipt: recoveryReceipt(),
    ...overrides,
  });

interface RecoveryHarnessResult {
  readonly harness: Harness;
  readonly spawns: readonly StageExecutionRequest[];
}

const createRecoveryHarness = (
  overrides: {
    readonly missingState?: boolean;
    readonly loaded?: PipelineState;
    readonly expectedReceiptRunId?: string;
    readonly attestScope?: ScopeAttestor;
    readonly readGitHead?: () => Promise<string>;
  } = {},
): RecoveryHarnessResult => {
  const spawns: StageExecutionRequest[] = [];
  const executor: WorkflowExecutor = {
    id: "recovery-fake",
    execute: (request) => {
      spawns.push(request);
      return Promise.reject(new Error("recovery should not spawn"));
    },
  };
  const attestScope =
    overrides.attestScope ??
    vi.fn<ScopeAttestor>().mockResolvedValue({
      kind: "final-receipt",
      receipt: recoveryReceipt(),
    });
  const readGitHead = overrides.readGitHead ?? (async () => RECOVERY_BASE_OID);
  const loaded =
    overrides.missingState === true ? undefined : (overrides.loaded ?? recoveryDoneState());
  const harness = createHarness({
    ...(loaded === undefined ? {} : { loaded }),
    request: {
      terminalRecovery: {
        kind: "supersede-contract-invalid-candidate",
        expectedReceiptRunId: overrides.expectedReceiptRunId ?? SEED_RECEIPT_RUN_ID,
        reason: "Contract defect: delivered payload counters diverge.",
      },
    },
    deps: {
      runStages: runPipelineStages,
      createExecutor: () => executor,
      attestScope,
      readGitHead,
      selectAndCompile: async () => ({
        id: RECOVERY_RUNDEF_ID,
        source: "discovered",
        path: "/root/.pi/bmad/pipelines/sdlc.yaml",
        runDef: RECOVERY_RUNDEF,
        stages: recoveryStages(),
      }),
    },
  });
  return { harness, spawns };
};

const TIMEOUT_BUMPED_RUNDEF: RunDef = {
  ...RECOVERY_RUNDEF,
  stages: RECOVERY_RUNDEF.stages.map((stage) => ({ ...stage, timeout: 7200 })),
};
const TIMEOUT_BUMPED_DIGEST = computeRunDefDigest(TIMEOUT_BUMPED_RUNDEF);

const failedRecoveryState = (): PipelineState => {
  const base = structuredClone(recoveryDoneState());
  Reflect.deleteProperty(base, "reviewCheckpoint");
  Reflect.deleteProperty(base, "finalScopeReceipt");
  const failedAttempt = Object.freeze({
    attempt: 2,
    status: "failed" as const,
    startedAt: timestamp,
    finishedAt: timestamp,
    durationMs: 1,
    exitCode: 1,
    reason: "prior correction failed",
  });
  const pending = (id: string): StageState => {
    const previous = passedRecoveryStage(id);
    return Object.freeze({
      id,
      status: "pending",
      attempts: previous.attempts,
      startedAt: null,
      finishedAt: null,
      history: previous.history,
    });
  };
  const previousDev = passedRecoveryStage("dev-story");
  return Object.freeze({
    ...base,
    runnerFeatureVersion: 3,
    status: "failed",
    currentStage: null,
    finishedAt: timestamp,
    stages: Object.freeze({
      "dev-story": Object.freeze({
        id: "dev-story",
        status: "failed",
        attempts: 2,
        startedAt: timestamp,
        finishedAt: timestamp,
        history: Object.freeze([...previousDev.history, failedAttempt]),
        reason: failedAttempt.reason,
      }),
      "code-review": pending("code-review"),
      docs: pending("docs"),
    }),
    runDefIdentity: RECOVERY_RUNDEF,
    supersededFinalScopeReceipts: Object.freeze([
      Object.freeze({
        version: 1,
        sequence: 1,
        kind: "supersede-contract-invalid-candidate",
        supersededAt: timestamp,
        supersededByRunId: "correction-run-1",
        expectedReceiptRunId: SEED_RECEIPT_RUN_ID,
        reason: "Contract defect: delivered payload counters diverge.",
        resetTargetStageId: "dev-story",
        finalScopeReceipt: recoveryReceipt(),
        runDefIdentity: RECOVERY_RUNDEF,
      }),
    ]),
  });
};

const legacyFailedRecoveryState = (receiptDigest = RECOVERY_RUNDEF_DIGEST): PipelineState => {
  const state = failedRecoveryState();
  const archived = state.supersededFinalScopeReceipts?.[0];
  if (archived === undefined) throw new Error("missing fixture archive");
  const legacy = {
    ...archived,
    finalScopeReceipt: { ...archived.finalScopeReceipt, runDefDigest: receiptDigest },
  };
  Reflect.deleteProperty(legacy, "runDefIdentity");
  return Object.freeze({
    ...state,
    supersededFinalScopeReceipts: Object.freeze([Object.freeze(legacy)]),
  });
};

const rejectingInvalidSave = vi.fn(async (_root: string, state: PipelineState) => {
  const reason = getPipelineStateInvalidReason(state);
  if (reason !== undefined) throw Object.assign(new Error(reason), { code: "invalid-state" });
  return "/state.json";
});

const successfulRecoveryAttestor = (): ScopeAttestor => async (request) => {
  if (request.phase === "review") {
    return {
      kind: "review-checkpoint",
      checkpoint: createReviewScopeCheckpoint({
        storyId: request.storyId,
        runId: request.runId,
        runDefId: request.runDefId,
        runDefDigest: request.runDefDigest,
        branch: "main",
        baseOid: RECOVERY_BASE_OID,
        reviewedFiles: [{ path: "src/app.ts", bytes: new Uint8Array() }],
        qualityGate: request.qualityGate,
      }),
    };
  }
  if (request.reviewCheckpoint === undefined) {
    return { kind: "rejected", reason: "missing checkpoint" };
  }
  return {
    kind: "final-receipt",
    receipt: createFinalScopeReceipt({
      checkpoint: request.reviewCheckpoint,
      comparison: {
        kind: "attested",
        docs: createCanonicalRepositoryScope([{ path: "README.md", bytes: new Uint8Array() }]),
        finalWorkingTreeDigest: createCanonicalRepositoryScope([
          { path: "src/app.ts", bytes: new Uint8Array() },
          { path: "README.md", bytes: new Uint8Array() },
        ]).digest,
      },
    }),
  };
};

const passingExecutor = (): WorkflowExecutor => ({
  id: "recovery-success",
  execute: async () => ({
    output: { payload: { ok: true } },
    exitCode: 0,
    durationMs: 1,
  }),
});

describe("terminal recovery timeout-only RunDef tolerance", () => {
  it("backfills a matching legacy archive before the timeout-adoption first save", async () => {
    const loaded = legacyFailedRecoveryState();
    const harness = createHarness({
      loaded,
      request: {
        terminalRecovery: {
          kind: "supersede-contract-invalid-candidate",
          expectedReceiptRunId: SEED_RECEIPT_RUN_ID,
          reason: "Contract defect: delivered payload counters diverge.",
        },
      },
      deps: {
        runStages: runPipelineStages,
        createExecutor: passingExecutor,
        attestScope: successfulRecoveryAttestor(),
        selectAndCompile: async () => ({
          id: RECOVERY_RUNDEF_ID,
          source: "discovered",
          path: "/root/.pi/bmad/pipelines/sdlc.yaml",
          runDef: TIMEOUT_BUMPED_RUNDEF,
          stages: recoveryStages().map((stage) => ({ ...stage, timeoutSeconds: 7200 })),
        }),
      },
    });

    const result = await runPipelineAction(harness.request);

    expect(result).toMatchObject({
      status: "passed",
      stagesRun: ["dev-story", "code-review", "docs"],
    });
    expect(harness.saves[0]).toMatchObject({
      runDefDigest: TIMEOUT_BUMPED_DIGEST,
      runDefIdentity: TIMEOUT_BUMPED_RUNDEF,
      supersededFinalScopeReceipts: [{ runDefIdentity: RECOVERY_RUNDEF }],
    });
    const backfilled = harness.saves[0]?.supersededFinalScopeReceipts?.[0]?.runDefIdentity;
    expect(computeRunDefDigest(backfilled!)).toBe(RECOVERY_RUNDEF_DIGEST);
    expect(backfilled).not.toBe(loaded.runDefIdentity);
    expect(backfilled?.stages).not.toBe(loaded.runDefIdentity?.stages);
    expect(Object.isFrozen(backfilled)).toBe(true);
    expect(Object.isFrozen(backfilled?.stages)).toBe(true);
    expect(getPipelineStateInvalidReason(harness.saves[0])).toBeUndefined();
    expect(new Set(harness.saves.map(({ runDefDigest }) => runDefDigest))).toEqual(
      new Set([TIMEOUT_BUMPED_DIGEST]),
    );
    const final = harness.saves.at(-1);
    expect(final?.finalScopeReceipt).toMatchObject({
      runId: "run-1",
      runDefDigest: TIMEOUT_BUMPED_DIGEST,
    });
    expect(final?.supersededFinalScopeReceipts?.[0]?.finalScopeReceipt).toEqual(
      loaded.supersededFinalScopeReceipts?.[0]?.finalScopeReceipt,
    );
    expect(getPipelineStateInvalidReason(final)).toBeUndefined();
    expect(final?.economics).toEqual(loaded.economics);
    expect(final?.regressions).toBe(loaded.regressions);
    expect(final?.stages["dev-story"]?.history.slice(0, 2)).toEqual(
      loaded.stages["dev-story"]?.history,
    );
  });

  it("leaves mismatched legacy archives unbackfilled so the adoption save fails closed", async () => {
    rejectingInvalidSave.mockClear();
    const loaded = legacyFailedRecoveryState("f".repeat(64));
    const harness = createHarness({
      loaded,
      request: {
        terminalRecovery: {
          kind: "supersede-contract-invalid-candidate",
          expectedReceiptRunId: SEED_RECEIPT_RUN_ID,
          reason: "Contract defect: delivered payload counters diverge.",
        },
      },
      deps: {
        saveState: rejectingInvalidSave,
        runStages: runPipelineStages,
        createExecutor: passingExecutor,
        attestScope: successfulRecoveryAttestor(),
        selectAndCompile: async () => ({
          id: RECOVERY_RUNDEF_ID,
          source: "discovered",
          path: "/root/.pi/bmad/pipelines/sdlc.yaml",
          runDef: TIMEOUT_BUMPED_RUNDEF,
          stages: recoveryStages().map((stage) => ({ ...stage, timeoutSeconds: 7200 })),
        }),
      },
    });

    const result = await runPipelineAction(harness.request);

    expect(result).toMatchObject({ status: "needs-attention" });
    expect(rejectingInvalidSave).toHaveBeenCalledTimes(1);
    const rejected = rejectingInvalidSave.mock.calls[0]?.[1];
    expect(rejected?.supersededFinalScopeReceipts?.[0]).not.toHaveProperty("runDefIdentity");
  });

  it("never overwrites an archive identity already present during adoption", async () => {
    const loaded = failedRecoveryState();
    const existing = loaded.supersededFinalScopeReceipts?.[0]?.runDefIdentity;
    const runStages = vi.fn(async (request: RunPipelineStagesRequest) => ({
      state: request.state,
      status: "done" as const,
      stagesRun: [],
      regressions: request.state.regressions,
    }));
    const harness = createHarness({
      loaded,
      request: {
        terminalRecovery: {
          kind: "supersede-contract-invalid-candidate",
          expectedReceiptRunId: SEED_RECEIPT_RUN_ID,
          reason: "Contract defect: delivered payload counters diverge.",
        },
      },
      deps: {
        runStages,
        selectAndCompile: async () => ({
          id: RECOVERY_RUNDEF_ID,
          source: "discovered",
          path: "/root/.pi/bmad/pipelines/sdlc.yaml",
          runDef: TIMEOUT_BUMPED_RUNDEF,
          stages: recoveryStages().map((stage) => ({ ...stage, timeoutSeconds: 7200 })),
        }),
      },
    });

    await runPipelineAction(harness.request);

    expect(
      runStages.mock.calls[0]?.[0].state.supersededFinalScopeReceipts?.[0]?.runDefIdentity,
    ).toBe(existing);
  });

  it("keeps rejecting gate/onFail changes on a tail-matching correction", async () => {
    const changed: RunDef = {
      ...TIMEOUT_BUMPED_RUNDEF,
      stages: TIMEOUT_BUMPED_RUNDEF.stages.map((stage) =>
        stage.id === "code-review" && stage.kind === "agent"
          ? { ...stage, gate: "e2e-verify", onFail: "dev-story" }
          : stage,
      ),
    };
    const runStages = vi.fn(doneFsm);
    const harness = createHarness({
      loaded: failedRecoveryState(),
      request: {
        terminalRecovery: {
          kind: "supersede-contract-invalid-candidate",
          expectedReceiptRunId: SEED_RECEIPT_RUN_ID,
          reason: "Contract defect: delivered payload counters diverge.",
        },
      },
      deps: {
        runStages,
        selectAndCompile: async () => ({
          id: RECOVERY_RUNDEF_ID,
          source: "discovered",
          path: "/root/.pi/bmad/pipelines/sdlc.yaml",
          runDef: changed,
          stages: recoveryStages(),
        }),
      },
    });

    const result = await runPipelineAction(harness.request);

    expect(result).toMatchObject({
      status: "needs-attention",
      error: expect.stringContaining("RunDef identity"),
    });
    expect(runStages).not.toHaveBeenCalled();
    expect(harness.saves).toHaveLength(0);
  });

  it("keeps requiring an exact digest on the initial done recovery path", async () => {
    const runStages = vi.fn(doneFsm);
    const harness = createHarness({
      loaded: recoveryDoneState(),
      request: {
        terminalRecovery: {
          kind: "supersede-contract-invalid-candidate",
          expectedReceiptRunId: SEED_RECEIPT_RUN_ID,
          reason: "Contract defect: delivered payload counters diverge.",
        },
      },
      deps: {
        runStages,
        selectAndCompile: async () => ({
          id: RECOVERY_RUNDEF_ID,
          source: "discovered",
          path: "/root/.pi/bmad/pipelines/sdlc.yaml",
          runDef: TIMEOUT_BUMPED_RUNDEF,
          stages: recoveryStages(),
        }),
      },
    });

    const result = await runPipelineAction(harness.request);

    expect(result).toMatchObject({
      status: "needs-attention",
      error: expect.stringContaining("RunDef identity"),
    });
    expect(runStages).not.toHaveBeenCalled();
    expect(harness.saves).toHaveLength(0);
  });

  it("rejects timeout-only RunDef drift on an ordinary resume without recovery flags", async () => {
    const runStages = vi.fn(runPipelineStages);
    const harness = createHarness({
      loaded: failedRecoveryState(),
      deps: {
        runStages,
        createExecutor: passingExecutor,
        attestScope: successfulRecoveryAttestor(),
        selectAndCompile: async () => ({
          id: RECOVERY_RUNDEF_ID,
          source: "discovered",
          path: "/root/.pi/bmad/pipelines/sdlc.yaml",
          runDef: TIMEOUT_BUMPED_RUNDEF,
          stages: recoveryStages().map((stage) => ({ ...stage, timeoutSeconds: 7200 })),
        }),
      },
    });

    const result = await runPipelineAction(harness.request);

    expect(result).toMatchObject({
      status: "needs-attention",
      error: expect.stringContaining("RunDef identity"),
    });
    expect(runStages).not.toHaveBeenCalled();
    expect(harness.saves).toHaveLength(0);
  });

  it.each(["paused", "needs-approval"] as const)(
    "rejects timeout-only recovery drift from an ineligible %s state",
    async (status) => {
      const runStages = vi.fn(doneFsm);
      const harness = createHarness({
        loaded: { ...failedRecoveryState(), status },
        request: {
          terminalRecovery: {
            kind: "supersede-contract-invalid-candidate",
            expectedReceiptRunId: SEED_RECEIPT_RUN_ID,
            reason: "Contract defect: delivered payload counters diverge.",
          },
        },
        deps: {
          runStages,
          selectAndCompile: async () => ({
            id: RECOVERY_RUNDEF_ID,
            source: "discovered",
            path: "/root/.pi/bmad/pipelines/sdlc.yaml",
            runDef: TIMEOUT_BUMPED_RUNDEF,
            stages: recoveryStages().map((stage) => ({ ...stage, timeoutSeconds: 7200 })),
          }),
        },
      });

      const result = await runPipelineAction(harness.request);

      expect(result).toMatchObject({
        status: "needs-attention",
        error: expect.stringContaining("RunDef identity"),
      });
      expect(runStages).not.toHaveBeenCalled();
      expect(harness.saves).toHaveLength(0);
    },
  );

  it("resumes an authority-free post-correction state without flags on the exact digest", async () => {
    const harness = createHarness({
      loaded: failedRecoveryState(),
      deps: {
        runStages: runPipelineStages,
        createExecutor: passingExecutor,
        attestScope: successfulRecoveryAttestor(),
        selectAndCompile: async () => ({
          id: RECOVERY_RUNDEF_ID,
          source: "discovered",
          path: "/root/.pi/bmad/pipelines/sdlc.yaml",
          runDef: RECOVERY_RUNDEF,
          stages: recoveryStages(),
        }),
      },
    });

    const result = await runPipelineAction(harness.request);

    expect(result).toMatchObject({
      status: "passed",
      stagesRun: ["dev-story", "code-review", "docs"],
    });
    const final = harness.saves.at(-1);
    expect(final?.status).toBe("done");
    expect(final?.supersededFinalScopeReceipts).toHaveLength(1);
    expect(final?.supersededFinalScopeReceipts?.[0]?.expectedReceiptRunId).toBe(
      SEED_RECEIPT_RUN_ID,
    );
    expect(final?.finalScopeReceipt).toMatchObject({ runId: "run-1" });
    expect(getPipelineStateInvalidReason(final)).toBeUndefined();
  });
});

describe("recovery eligibility precedes any state write", () => {
  it("rejects a missing state without initializing or saving", async () => {
    const { harness } = createRecoveryHarness({ missingState: true });

    const result = await runPipelineAction(harness.request);

    expect(result).toMatchObject({ status: "needs-attention" });
    expect(result.error).toContain("no state file was found");
    expect(harness.calls).not.toContain("save");
    expect(harness.calls).not.toContain("fsm");
  });

  it("rejects a stale expected receipt run id without saving or spawning", async () => {
    const { harness, spawns } = createRecoveryHarness({
      expectedReceiptRunId: "stale-run-9",
    });

    const result = await runPipelineAction(harness.request);

    expect(result).toMatchObject({ status: "needs-attention" });
    expect(result.error).toContain('expected receipt run id "stale-run-9"');
    expect(harness.saves).toHaveLength(0);
    expect(spawns).toHaveLength(0);
  });

  it("rejects drift without saving or spawning", async () => {
    const attestScope = vi.fn<ScopeAttestor>().mockResolvedValue({
      kind: "rejected",
      reason: "Git scope changed after the final receipt.",
    });
    const { harness, spawns } = createRecoveryHarness({ attestScope });

    const result = await runPipelineAction(harness.request);

    expect(result).toMatchObject({ status: "needs-attention" });
    expect(result.error).toMatch(/scope attestation|scope changed/u);
    expect(harness.saves).toHaveLength(0);
    expect(spawns).toHaveLength(0);
  });

  it("rejects a committed feature HEAD without saving or spawning", async () => {
    const { harness, spawns } = createRecoveryHarness({
      readGitHead: async () => "b".repeat(40),
    });

    const result = await runPipelineAction(harness.request);

    expect(result).toMatchObject({ status: "needs-attention" });
    expect(result.error).toMatch(/HEAD is not at the receipt base/u);
    expect(harness.saves).toHaveLength(0);
    expect(spawns).toHaveLength(0);
  });

  it("rejects a non-done state without saving or spawning", async () => {
    const { harness, spawns } = createRecoveryHarness({
      loaded: { ...recoveryDoneState(), status: "running" },
    });

    const result = await runPipelineAction(harness.request);

    expect(result).toMatchObject({ status: "needs-attention" });
    expect(result.error).toMatch(/requires a done state/u);
    expect(harness.saves).toHaveLength(0);
    expect(spawns).toHaveLength(0);
  });

  it("rejects reconciliation-needed state with the active receipt before any recovery effect", async () => {
    const needsReconcile: PipelineState = {
      ...recoveryDoneState(),
      status: "done",
      currentStage: "code-review",
      finishedAt: null,
    };
    const attestScope = vi.fn<ScopeAttestor>();
    const readGitHead = vi.fn(async () => RECOVERY_BASE_OID);
    const { harness, spawns } = createRecoveryHarness({
      loaded: needsReconcile,
      attestScope,
      readGitHead,
    });

    const result = await runPipelineAction(harness.request);

    expect(result).toMatchObject({ status: "needs-attention" });
    expect(harness.saves).toHaveLength(0);
    expect(attestScope).not.toHaveBeenCalled();
    expect(readGitHead).not.toHaveBeenCalled();
    expect(harness.calls).not.toContain("executor");
    expect(spawns).toHaveLength(0);
  });
});
