import { describe, expect, it } from "vitest";

import {
  BMAD_PIPELINE_MODEL_ENV_VAR,
  BMAD_PIPELINE_THINKING_ENV_VAR,
  INTERNAL_ERROR_CODE,
  LOCK_HELD_ERROR_CODE,
  RUN_PIPELINE_ACTION_NAME,
  defaultRunPipelineActionDeps,
  runPipelineAction,
  type CreateStageExecutorOptions,
  type RunPipelineActionDeps,
  type RunPipelineActionRequest,
} from "./index.js";
import { generatePipelineAuditReport } from "../audit/index.js";
import { runPipelineStages, type RunPipelineStagesResult } from "../core/index.js";
import { PiCliWorkflowExecutor } from "../executors/index.js";
import { registerBmadPayloadGates } from "../gates/index.js";
import { ensureStoryWorktree, openStoryPullRequest } from "../git/index.js";
import { resolveModelConfig } from "../model/index.js";
import { payloadGateRegistry, selectAndCompileRunDef } from "../rundef/index.js";
import { runHarnessEvidence, saveHarnessEvidence } from "../security/index.js";
import {
  acquireDispatchLock,
  createInitialPipelineState,
  loadPipelineState,
  reconcilePipelineState,
  savePipelineState,
} from "../state/index.js";

import type { RunPipelineStagesRequest } from "../core/index.js";
import type { WorkflowExecutor } from "../executors/index.js";
import type { StoryWorktree } from "../git/index.js";
import type { CompiledStageDef, RunDef } from "../rundef/index.js";
import type { HarnessEvidenceReport } from "../security/index.js";
import type { DispatchLock, PipelineState } from "../state/index.js";

const T0 = "2026-08-05T00:00:00.000Z";

const fixedClock = (): (() => Date) => {
  let tick = 0;
  return () => new Date(Date.parse(T0) + tick++ * 1000);
};

const stageDef = (
  id: string,
  index: number,
  overrides: Partial<CompiledStageDef> = {},
): CompiledStageDef => ({
  id,
  kind: "agent",
  workflow: `wf-${id}`,
  agent: "dev",
  index,
  timeoutSeconds: 60,
  ...overrides,
});

const fixtureStages = (): readonly CompiledStageDef[] => [
  stageDef("a", 0),
  stageDef("b", 1, { payloadGateName: "e2e-verify", payloadGate: () => ({ passed: true }) }),
];

const fixtureRunDef = (stages: readonly CompiledStageDef[]): RunDef => ({
  id: "sdlc",
  stages: stages.map((stage) => ({
    id: stage.id,
    kind: stage.kind,
    workflow: stage.workflow,
    agent: stage.agent,
  })),
});

const evidenceReport = (projectRoot: string, passed: boolean): HarnessEvidenceReport => ({
  projectRoot,
  startedAt: T0,
  finishedAt: T0,
  passed,
  commands: [
    {
      name: "test",
      command: "npm",
      args: ["test"],
      status: passed ? "passed" : "failed",
      exitCode: passed ? 0 : 1,
      durationMs: 1,
      stdout: "",
      stderr: "",
    },
  ],
});

/** Scripted FSM stand-in that exercises the observer and saveState wiring. */
const fakeFsm =
  (overrides: Partial<RunPipelineStagesResult> = {}) =>
  async (request: RunPipelineStagesRequest): Promise<RunPipelineStagesResult> => {
    const [first, gated] = request.stages;
    if (first === undefined || gated === undefined) {
      throw new Error("fixture stages missing");
    }
    request.observer?.onStageStarted?.({ stage: first, attempt: 1 });
    request.observer?.onStageFinished?.({
      stage: gated,
      attempt: 1,
      decision: { stageId: gated.id, kind: "passed", passed: true, reason: "stage ok" },
      route: {
        action: "complete",
        fromStageId: gated.id,
        regressions: 0,
        reason: "all stages passed",
      },
      execution: { output: { payload: {} }, exitCode: 0, durationMs: 5 },
    });
    const state: PipelineState = {
      ...request.state,
      status: "done",
      finishedAt: T0,
      economics: { tokens: 12, dollars: 0.5 },
    };
    await request.saveState(state);
    return Object.freeze({
      state,
      status: "done",
      stagesRun: Object.freeze(["a", "b"]),
      regressions: 0,
      ...overrides,
    });
  };

interface HarnessOverrides {
  readonly request?: Partial<RunPipelineActionRequest>;
  readonly deps?: Partial<RunPipelineActionDeps>;
  readonly lockHeld?: boolean;
  readonly loaded?: PipelineState;
  readonly evidencePassed?: boolean;
  readonly fsm?: Partial<RunPipelineStagesResult>;
  readonly omitSink?: boolean;
  readonly omitNow?: boolean;
}

interface Harness {
  readonly request: RunPipelineActionRequest;
  readonly calls: string[];
  readonly saves: PipelineState[];
  readonly executorOptions: CreateStageExecutorOptions[];
  readonly fsmRequests: RunPipelineStagesRequest[];
  readonly events: () => Record<string, unknown>[];
}

const fixtureWorktree: StoryWorktree = Object.freeze({
  storyId: "SH-1",
  branch: "bmad/SH-1",
  path: "/wt/SH-1",
});

const harness = (overrides: HarnessOverrides = {}): Harness => {
  const calls: string[] = [];
  const saves: PipelineState[] = [];
  const lines: string[] = [];
  const executorOptions: CreateStageExecutorOptions[] = [];
  const fsmRequests: RunPipelineStagesRequest[] = [];
  const stages = fixtureStages();
  const lock: DispatchLock = {
    storyId: "SH-1",
    path: "/locks/SH-1",
    info: { pid: 1, runId: "run-1", startedAt: T0 },
    release: async () => {
      calls.push("lock.release");
    },
  };
  const executor: WorkflowExecutor = {
    id: "fake",
    execute: () => Promise.reject(new Error("not used")),
  };
  const deps: Partial<RunPipelineActionDeps> = {
    acquireLock: async (request) => {
      calls.push(`acquireLock:${request.storyId}:${request.runId}`);
      return overrides.lockHeld === true ? undefined : lock;
    },
    loadState: async () => {
      calls.push("loadState");
      return overrides.loaded;
    },
    saveState: async (_projectRoot, state) => {
      calls.push("saveState");
      saves.push(state);
      return `/state/${state.storyId}.json`;
    },
    reconcileState: (request) => {
      calls.push("reconcileState");
      return reconcilePipelineState(request);
    },
    ensureWorktree: async () => {
      calls.push("ensureWorktree");
      return fixtureWorktree;
    },
    registerGates: () => {
      calls.push("registerGates");
      return { registered: ["e2e-verify", "code-review"] };
    },
    selectAndCompile: async (_projectRoot, id, options) => {
      calls.push(
        `selectAndCompile:${id}:registry=${String(options?.registry === payloadGateRegistry)}`,
      );
      return { id, source: "builtin", runDef: fixtureRunDef(stages), stages };
    },
    createExecutor: (options) => {
      calls.push("createExecutor");
      executorOptions.push(options);
      return executor;
    },
    runStages: async (request) => {
      calls.push("runStages");
      fsmRequests.push(request);
      return fakeFsm(overrides.fsm)(request);
    },
    runEvidence: async (request) => {
      calls.push(`runEvidence:${request.projectRoot}:${request.commandCwd ?? "<none>"}`);
      return evidenceReport(request.projectRoot, overrides.evidencePassed ?? true);
    },
    saveEvidence: async (request) => {
      calls.push(`saveEvidence:${request.projectRoot}`);
      return `${request.projectRoot}/evidence.json`;
    },
    openPullRequest: async (request) => {
      calls.push("openPullRequest");
      return {
        storyId: request.storyId,
        branch: request.branch,
        baseBranch: "main",
        title: "BMAD: SH-1",
        body: "body",
        url: "https://github.com/acme/repo/pull/7",
        number: 7,
      };
    },
    generateAuditReport: (request) => {
      calls.push(`audit:${request.action}`);
      return generatePipelineAuditReport(request);
    },
    createRunId: () => "run-1",
    ...overrides.deps,
  };
  const request: RunPipelineActionRequest = {
    rundefId: "sdlc",
    storyId: "SH-1",
    specFile: "spec.md",
    projectRoot: "/root",
    openPr: false,
    ...(overrides.omitSink === true
      ? {}
      : {
          sink: {
            write: (line) => {
              lines.push(line);
            },
          },
        }),
    ...(overrides.omitNow === true ? {} : { now: fixedClock() }),
    deps,
    ...overrides.request,
  };
  return {
    request,
    calls,
    saves,
    executorOptions,
    fsmRequests,
    events: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
};

const indexOfCall = (calls: readonly string[], prefix: string): number =>
  calls.findIndex((call) => call.startsWith(prefix));

describe("runPipelineAction", () => {
  it("runs the full happy path without a PR and emits the event stream", async () => {
    const { request, calls, events } = harness();

    const result = await runPipelineAction(request);

    expect(Object.isFrozen(result)).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.action).toBe(RUN_PIPELINE_ACTION_NAME);
    expect(result.storyId).toBe("SH-1");
    expect(result.specFile).toBe("spec.md");
    expect(result.stagesRun).toEqual(["a", "b"]);
    expect(result.regressions).toBe(0);
    expect(result.worktreePath).toBe("/wt/SH-1");
    expect(result.branch).toBe("bmad/SH-1");
    expect(result.economics).toEqual({ tokens: 12, dollars: 0.5 });
    expect(result.error).toBeUndefined();
    expect(result.prUrl).toBeUndefined();
    expect(calls).not.toContain("openPullRequest");
    expect(calls).toContain("selectAndCompile:sdlc:registry=true");
    expect(calls).toContain("runEvidence:/root:/wt/SH-1");
    expect(calls).toContain("saveEvidence:/root");
    expect(calls).toContain("audit:run");
    expect(calls.at(-1)).toBe("lock.release");
    expect(events().map((event) => event["event"])).toEqual([
      "run.started",
      "stage.started",
      "stage.finished",
      "gate.decision",
      "evidence.finished",
      "result",
    ]);
  });

  it("stamps the envelope and payload fields on emitted events", async () => {
    const { request, events } = harness();

    await runPipelineAction(request);

    const [started, stageStarted, stageFinished, gate, evidence, result] = events();
    expect(started).toMatchObject({ rundefId: "sdlc", specFile: "spec.md", storyId: "SH-1" });
    expect(typeof started?.["ts"]).toBe("string");
    expect(stageStarted).toMatchObject({ stageId: "a", attempt: 1 });
    expect(stageFinished).toMatchObject({
      stageId: "b",
      attempt: 1,
      kind: "passed",
      passed: true,
      exitCode: 0,
      durationMs: 5,
      reason: "stage ok",
    });
    expect(gate).toMatchObject({
      stageId: "b",
      gate: "e2e-verify",
      passed: true,
      findings: [],
    });
    expect(evidence).toMatchObject({ passed: true, failedCommands: [] });
    expect(result).toMatchObject({
      status: "passed",
      stagesRun: ["a", "b"],
      regressions: 0,
    });
  });

  it("orders effects: lock, load, gates, compile, worktree, executor, FSM, evidence", async () => {
    const { request, calls } = harness();

    await runPipelineAction(request);

    const order = [
      "acquireLock",
      "loadState",
      "registerGates",
      "selectAndCompile",
      "ensureWorktree",
      "createExecutor",
      "runStages",
      "runEvidence",
      "audit:run",
      "lock.release",
    ].map((prefix) => indexOfCall(calls, prefix));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
  });

  it("runs evidence commands in the worktree but keeps the supervised project root as evidence identity and persistence root", async () => {
    const { request, calls } = harness();

    await runPipelineAction(request);

    expect(calls).toContain("runEvidence:/root:/wt/SH-1");
    expect(calls).toContain("saveEvidence:/root");
    expect(calls).not.toContain("saveEvidence:/wt/SH-1");
  });

  it("opens a PR and finalizes state as pr-opened when openPr is true", async () => {
    const { request, calls, saves, events } = harness({ request: { openPr: true } });

    const result = await runPipelineAction(request);

    expect(result.status).toBe("pr-opened");
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/7");
    expect(result.prNumber).toBe(7);
    expect(calls).toContain("openPullRequest");
    expect(saves.at(-1)?.status).toBe("pr-opened");
    const eventTypes = events().map((event) => event["event"]);
    expect(eventTypes).toContain("pr.opened");
    const prEvent = events().find((event) => event["event"] === "pr.opened");
    expect(prEvent).toMatchObject({
      prUrl: "https://github.com/acme/repo/pull/7",
      prNumber: 7,
      branch: "bmad/SH-1",
    });
    const resultEvent = events().find((event) => event["event"] === "result");
    expect(resultEvent).toMatchObject({ status: "pr-opened" });
  });

  it("fails closed as needs-attention on dispatch lock contention", async () => {
    const { request, calls, events } = harness({ lockHeld: true, omitNow: true });

    const result = await runPipelineAction(request);

    expect(result.status).toBe("needs-attention");
    expect(result.stagesRun).toEqual([]);
    expect(result.error).toContain("SH-1");
    expect(calls).not.toContain("selectAndCompile:sdlc");
    expect(calls).not.toContain("lock.release");
    expect(events().map((event) => event["event"])).toEqual(["error", "result"]);
    expect(events()[0]).toMatchObject({ code: LOCK_HELD_ERROR_CODE });
    expect(events()[1]).toMatchObject({ status: "needs-attention" });
  });

  it("fails closed as needs-attention when harness evidence fails", async () => {
    const { request, calls, saves, events } = harness({
      evidencePassed: false,
      request: { openPr: true },
    });

    const result = await runPipelineAction(request);

    expect(result.status).toBe("needs-attention");
    expect(result.error).toContain("test");
    expect(calls).not.toContain("openPullRequest");
    expect(saves.at(-1)?.status).toBe("needs-attention");
    const evidence = events().find((event) => event["event"] === "evidence.finished");
    expect(evidence).toMatchObject({ passed: false, failedCommands: ["test"] });
    const resultEvent = events().find((event) => event["event"] === "result");
    expect(resultEvent).toMatchObject({ status: "needs-attention" });
    expect(calls.at(-1)).toBe("lock.release");
  });

  it("propagates FSM needs-attention failure as data without running evidence", async () => {
    const { request, calls, events } = harness({
      fsm: {
        status: "needs-attention",
        failure: { code: "executor-error", stageId: "a", reason: "child exploded" },
      },
    });

    const result = await runPipelineAction(request);

    expect(result.status).toBe("needs-attention");
    expect(result.error).toBe("child exploded");
    expect(indexOfCall(calls, "runEvidence")).toBe(-1);
    const resultEvent = events().find((event) => event["event"] === "result");
    expect(resultEvent).toMatchObject({ status: "needs-attention", error: "child exploded" });
    expect(calls.at(-1)).toBe("lock.release");
  });

  it("propagates FSM failed status with a default event sink", async () => {
    const { request, calls } = harness({
      omitSink: true,
      fsm: {
        status: "failed",
        failure: { code: "stage-failed", stageId: "b", reason: "stage b failed" },
      },
    });

    const result = await runPipelineAction(request);

    expect(result.status).toBe("failed");
    expect(result.error).toBe("stage b failed");
    expect(indexOfCall(calls, "runEvidence")).toBe(-1);
    expect(calls).toContain("audit:run");
  });

  it("releases the lock and fails closed when a step throws a coded error", async () => {
    const boom = Object.assign(new Error("worktree exploded"), { code: "git-command-failed" });
    const { request, calls, events } = harness({
      deps: {
        ensureWorktree: async () => {
          throw boom;
        },
      },
    });

    const result = await runPipelineAction(request);

    expect(result.status).toBe("needs-attention");
    expect(result.error).toBe("worktree exploded");
    expect(calls).toContain("lock.release");
    const errorEvent = events().find((event) => event["event"] === "error");
    expect(errorEvent).toMatchObject({ code: "git-command-failed", message: "worktree exploded" });
    const resultEvent = events().find((event) => event["event"] === "result");
    expect(resultEvent).toMatchObject({ status: "needs-attention" });
  });

  it("maps uncoded throws to the internal error code after the FSM", async () => {
    const { request, calls, events } = harness({
      request: { openPr: true },
      deps: {
        openPullRequest: async () => {
          throw new Error("gh failed");
        },
      },
    });

    const result = await runPipelineAction(request);

    expect(result.status).toBe("needs-attention");
    expect(result.error).toBe("gh failed");
    expect(calls.at(-1)).toBe("lock.release");
    const errorEvent = events().find((event) => event["event"] === "error");
    expect(errorEvent).toMatchObject({ code: INTERNAL_ERROR_CODE, message: "gh failed" });
  });

  it("resolves model and thinking from the injected env map (D7)", async () => {
    const { request, executorOptions, saves } = harness({
      request: {
        env: {
          [BMAD_PIPELINE_MODEL_ENV_VAR]: "env-model",
          [BMAD_PIPELINE_THINKING_ENV_VAR]: "high",
        },
      },
    });

    await runPipelineAction(request);

    expect(executorOptions).toEqual([{ model: "env-model", thinking: "high" }]);
    expect(saves[0]?.model).toBe("env-model");
    expect(saves[0]?.thinking).toBe("high");
  });

  it("prefers explicit model and thinking over the env map (D7)", async () => {
    const { request, executorOptions } = harness({
      request: {
        model: "cli-model",
        thinking: "low",
        env: {
          [BMAD_PIPELINE_MODEL_ENV_VAR]: "env-model",
          [BMAD_PIPELINE_THINKING_ENV_VAR]: "high",
        },
      },
    });

    await runPipelineAction(request);

    expect(executorOptions).toEqual([{ model: "cli-model", thinking: "low" }]);
  });

  it("creates and saves fresh initial state before running the FSM", async () => {
    const { request, calls, saves, fsmRequests } = harness();

    await runPipelineAction(request);

    const initial = saves[0];
    expect(initial?.status).toBe("pending");
    expect(initial?.worktreePath).toBe("/wt/SH-1");
    expect(initial?.branch).toBe("bmad/SH-1");
    expect(Object.keys(initial?.stages ?? {})).toEqual(["a", "b"]);
    expect(indexOfCall(calls, "saveState")).toBeLessThan(indexOfCall(calls, "runStages"));
    expect(fsmRequests[0]?.state).toBe(initial);
    expect(fsmRequests[0]?.worktreeCwd).toBe("/wt/SH-1");
  });

  it("reconciles crashed loaded state and persists repairs before the FSM", async () => {
    const crashed: PipelineState = {
      ...createInitialPipelineState({
        storyId: "SH-1",
        specFile: "spec.md",
        worktreePath: "/wt/SH-1",
        branch: "bmad/SH-1",
        stages: [...fixtureStages()],
        model: "m",
        thinking: "medium",
      }),
      status: "running",
    };
    const { request, calls, saves, fsmRequests } = harness({ loaded: crashed });

    await runPipelineAction(request);

    expect(calls).toContain("reconcileState");
    expect(saves[0]?.status).toBe("pending");
    expect(indexOfCall(calls, "saveState")).toBeLessThan(indexOfCall(calls, "runStages"));
    expect(fsmRequests[0]?.state.status).toBe("pending");
  });

  it("skips the pre-FSM save when loaded state needs no repair", async () => {
    const clean = createInitialPipelineState({
      storyId: "SH-1",
      specFile: "spec.md",
      worktreePath: "/wt/SH-1",
      branch: "bmad/SH-1",
      stages: [...fixtureStages()],
      model: "m",
      thinking: "medium",
    });
    const { request, calls } = harness({ loaded: clean });

    await runPipelineAction(request);

    expect(indexOfCall(calls, "saveState")).toBeGreaterThan(indexOfCall(calls, "runStages"));
  });

  it("forwards maxRegressions, runBudget, and signal to the FSM and evidence", async () => {
    const controller = new AbortController();
    const runBudget = { maxTokens: 1000 };
    const { request, fsmRequests } = harness({
      request: { maxRegressions: 5, runBudget, signal: controller.signal },
    });

    await runPipelineAction(request);

    expect(fsmRequests[0]?.maxRegressions).toBe(5);
    expect(fsmRequests[0]?.runBudget).toBe(runBudget);
    expect(fsmRequests[0]?.signal).toBe(controller.signal);
  });

  it("settles FSM needs-attention without failure details as data", async () => {
    const { request } = harness({ fsm: { status: "needs-attention" } });

    const result = await runPipelineAction(request);

    expect(result.status).toBe("needs-attention");
    expect(result.error).toBeUndefined();
  });

  it("defaults the PR number to zero when none can be parsed", async () => {
    const { request, events } = harness({
      request: { openPr: true },
      deps: {
        openPullRequest: async (prRequest) => ({
          storyId: prRequest.storyId,
          branch: prRequest.branch,
          baseBranch: "main",
          title: "BMAD: SH-1",
          body: "body",
          url: "https://github.com/acme/repo/compare/main...bmad/SH-1",
        }),
      },
    });

    const result = await runPipelineAction(request);

    expect(result.status).toBe("pr-opened");
    expect(result.prNumber).toBeUndefined();
    const prEvent = events().find((event) => event["event"] === "pr.opened");
    expect(prEvent).toMatchObject({ prNumber: 0 });
  });

  it("throws RangeError for programmer errors in the request", async () => {
    const invalid: readonly Partial<RunPipelineActionRequest>[] = [
      { storyId: " " },
      { storyId: "../escape" },
      { rundefId: " " },
      { specFile: " " },
      { projectRoot: " " },
    ];
    for (const override of invalid) {
      const { request } = harness({ request: override });
      await expect(runPipelineAction(request)).rejects.toThrow(RangeError);
    }
  });

  it("wires real implementations as default dependencies", () => {
    expect(defaultRunPipelineActionDeps.acquireLock).toBe(acquireDispatchLock);
    expect(defaultRunPipelineActionDeps.loadState).toBe(loadPipelineState);
    expect(defaultRunPipelineActionDeps.saveState).toBe(savePipelineState);
    expect(defaultRunPipelineActionDeps.reconcileState).toBe(reconcilePipelineState);
    expect(defaultRunPipelineActionDeps.ensureWorktree).toBe(ensureStoryWorktree);
    expect(defaultRunPipelineActionDeps.registerGates).toBe(registerBmadPayloadGates);
    expect(defaultRunPipelineActionDeps.selectAndCompile).toBe(selectAndCompileRunDef);
    expect(defaultRunPipelineActionDeps.resolveModel).toBe(resolveModelConfig);
    expect(defaultRunPipelineActionDeps.runStages).toBe(runPipelineStages);
    expect(defaultRunPipelineActionDeps.runEvidence).toBe(runHarnessEvidence);
    expect(defaultRunPipelineActionDeps.saveEvidence).toBe(saveHarnessEvidence);
    expect(defaultRunPipelineActionDeps.openPullRequest).toBe(openStoryPullRequest);
    expect(defaultRunPipelineActionDeps.generateAuditReport).toBe(generatePipelineAuditReport);
    expect(Object.isFrozen(defaultRunPipelineActionDeps)).toBe(true);
  });

  it("builds a real Pi executor and unique run ids from the defaults", () => {
    const executor = defaultRunPipelineActionDeps.createExecutor({
      model: "test-model",
      thinking: "medium",
    });
    expect(executor).toBeInstanceOf(PiCliWorkflowExecutor);
    const first = defaultRunPipelineActionDeps.createRunId();
    const second = defaultRunPipelineActionDeps.createRunId();
    expect(first).not.toBe("");
    expect(first).not.toBe(second);
  });
});
