import { describe, expect, it, vi } from "vitest";

import {
  BMAD_PIPELINE_MODEL_ENV_VAR,
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
} from "../core/index.js";
import { PiCliWorkflowExecutor, type WorkflowExecutor } from "../executors/index.js";
import { registerBmadPayloadGates } from "../gates/index.js";
import { ensureStoryWorktree } from "../git/index.js";
import { resolveModelConfig } from "../model/index.js";
import {
  computeRunDefDigest,
  payloadGateRegistry,
  selectAndCompileRunDef,
  type CompiledStageDef,
} from "../rundef/index.js";
import {
  acquireDispatchLock,
  createInitialPipelineState,
  loadPipelineState,
  reconcilePipelineState,
  savePipelineState,
  type DispatchLock,
  type PipelineState,
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
    ensureWorktree: async () => {
      calls.push("worktree");
      return { storyId: "SH-1", branch: "bmad/SH-1", path: "/wt" };
    },
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
    expect(result).toMatchObject({ status: "passed", stagesRun: ["dev"], worktreePath: "/wt" });
    expect(harness.calls).toEqual([
      "lock",
      "load",
      "gates",
      "select:true",
      "model",
      "worktree",
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
      worktreePath: "/wt",
      branch: "bmad/SH-1",
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

  it("fails closed when YAML changes but reuses the same stage ids", async () => {
    const changedRunDefState = createInitialPipelineState({
      storyId: "SH-1",
      runDefId: "sdlc",
      runDefDigest: computeRunDefDigest({
        id: "sdlc",
        stages: [{ id: "dev", kind: "agent", workflow: "older-workflow", agent: "dev" }],
      }),
      specFile: "spec.md",
      worktreePath: "/wt",
      branch: "bmad/SH-1",
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

  it("does not save clean loaded state before the FSM", async () => {
    const boundState = createInitialPipelineState({
      storyId: "SH-1",
      runDefId: "sdlc",
      runDefDigest: computeRunDefDigest({ id: "sdlc", stages: [] }),
      specFile: "spec.md",
      worktreePath: "/wt",
      branch: "bmad/SH-1",
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
    ["specFile", " "],
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

  it("wires real core defaults and creates a Pi executor", () => {
    expect(defaultRunPipelineActionDeps.acquireLock).toBe(acquireDispatchLock);
    expect(defaultRunPipelineActionDeps.loadState).toBe(loadPipelineState);
    expect(defaultRunPipelineActionDeps.saveState).toBe(savePipelineState);
    expect(defaultRunPipelineActionDeps.ensureWorktree).toBe(ensureStoryWorktree);
    expect(defaultRunPipelineActionDeps.registerGates).toBe(registerBmadPayloadGates);
    expect(defaultRunPipelineActionDeps.selectAndCompile).toBe(selectAndCompileRunDef);
    expect(defaultRunPipelineActionDeps.runStages).toBe(runPipelineStages);
    expect(
      defaultRunPipelineActionDeps.createExecutor({ model: "m", thinking: "medium" }),
    ).toBeInstanceOf(PiCliWorkflowExecutor);
  });
});
