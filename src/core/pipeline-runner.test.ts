import { describe, expect, it, vi } from "vitest";

import { DEFAULT_MAX_REGRESSIONS, runPipelineStages } from "./index.js";
import { createInitialPipelineState } from "../state/index.js";

import type { PipelineState, StageState } from "../state/index.js";
import type { CompiledStageDef } from "../rundef/index.js";
import type {
  StageExecutionRequest,
  StageExecutionResult,
  WorkflowExecutor,
} from "../executors/index.js";
import type { RunPipelineStagesRequest } from "./pipeline-runner.js";

const T0 = "2026-08-05T00:00:00.000Z";

const stage = (
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

const okGate = (payload: Record<string, unknown>) =>
  payload["ok"] === true
    ? { passed: true }
    : {
        passed: false,
        reason: "gate rejected payload",
        ...(Array.isArray(payload["findings"])
          ? { findings: payload["findings"] as string[] }
          : {}),
      };

const okResult = (overrides: Partial<StageExecutionResult> = {}): StageExecutionResult => ({
  output: { payload: { ok: true } },
  exitCode: 0,
  durationMs: 5,
  ...overrides,
});

const gateFailResult = (findings?: readonly string[]): StageExecutionResult =>
  okResult({
    output: { payload: { ok: false, ...(findings === undefined ? {} : { findings }) } },
  });

interface ScriptedExecutor extends WorkflowExecutor {
  readonly requests: StageExecutionRequest[];
}

type ScriptEntry = StageExecutionResult | Error | string | (() => StageExecutionResult);

const scriptedExecutor = (script: ScriptEntry[]): ScriptedExecutor => {
  const requests: StageExecutionRequest[] = [];
  return {
    id: "stub",
    requests,
    async execute(request) {
      requests.push(request);
      const next = script.shift();
      if (next === undefined) throw new Error("executor script exhausted");
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercises non-Error throws.
      if (next instanceof Error || typeof next === "string") throw next;
      return typeof next === "function" ? next() : next;
    },
  };
};

const fixedClock = (): (() => Date) => {
  let tick = 0;
  return () => new Date(Date.parse(T0) + tick++ * 1000);
};

interface Harness {
  readonly request: RunPipelineStagesRequest;
  readonly saves: PipelineState[];
  readonly executor: ScriptedExecutor;
}

const harness = (
  stages: readonly CompiledStageDef[],
  script: ScriptEntry[],
  overrides: Partial<RunPipelineStagesRequest> = {},
): Harness => {
  const saves: PipelineState[] = [];
  const executor = scriptedExecutor(script);
  const state = createInitialPipelineState({
    storyId: "SH-1",
    specFile: "spec.md",
    stages,
    model: "test-model",
    thinking: "medium",
  });
  return {
    saves,
    executor,
    request: {
      stages,
      state,
      storyId: "SH-1",
      specFile: "spec.md",
      projectRoot: "/root",
      executor,
      saveState: async (next) => {
        saves.push(next);
      },
      now: fixedClock(),
      ...overrides,
    },
  };
};

const twoStages = (): readonly CompiledStageDef[] => [stage("a", 0), stage("b", 1)];

const gatedStages = (): readonly CompiledStageDef[] => [
  stage("a", 0),
  stage("b", 1, { payloadGate: okGate, payloadGateName: "ok-gate", onFail: "a" }),
];

describe("runPipelineStages", () => {
  it("runs all stages to done and accumulates economics", async () => {
    const usage = { tokens: 10, dollars: 0.25 };
    const { request, executor } = harness(twoStages(), [okResult({ usage }), okResult({ usage })]);
    const { now, ...withoutClock } = request;
    expect(now).toBeTypeOf("function");

    const result = await runPipelineStages(withoutClock);

    expect(result.status).toBe("done");
    expect(result.stagesRun).toEqual(["a", "b"]);
    expect(result.regressions).toBe(0);
    expect(result.failure).toBeUndefined();
    expect(result.state.status).toBe("done");
    expect(result.state.currentStage).toBeNull();
    expect(result.state.startedAt).not.toBeNull();
    expect(result.state.finishedAt).not.toBeNull();
    expect(result.state.economics).toEqual({ tokens: 20, dollars: 0.5 });
    expect(result.state.stages["a"]?.status).toBe("passed");
    expect(result.state.stages["b"]?.status).toBe("passed");
    expect(result.state.stages["a"]?.attempts).toBe(1);
    expect(result.state.stages["a"]?.history).toHaveLength(1);
    expect(result.state.stages["a"]?.history[0]?.usage).toEqual(usage);
    expect(executor.requests[0]).toMatchObject({
      storyId: "SH-1",
      specFile: "spec.md",
      projectRoot: "/root",
      attempt: 1,
    });
    expect(executor.requests[0]?.priorFindings).toBeUndefined();
    expect(executor.requests[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("freezes the result, final state, and stagesRun", async () => {
    const { request } = harness(twoStages(), [okResult(), okResult()]);

    const result = await runPipelineStages(request);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.state)).toBe(true);
    expect(Object.isFrozen(result.state.stages)).toBe(true);
    expect(Object.isFrozen(result.state.stages["a"])).toBe(true);
    expect(Object.isFrozen(result.state.stages["a"]?.history)).toBe(true);
    expect(Object.isFrozen(result.stagesRun)).toBe(true);
  });

  it("does not mutate the caller's starting state", async () => {
    const { request } = harness(twoStages(), [okResult(), okResult()]);
    const snapshot = JSON.parse(JSON.stringify(request.state));

    await runPipelineStages(request);

    expect(JSON.parse(JSON.stringify(request.state))).toEqual(snapshot);
  });

  it("resumes from the first incomplete stage", async () => {
    const { request, executor } = harness(twoStages(), [okResult()]);
    const passed: StageState = {
      id: "a",
      status: "passed",
      attempts: 1,
      startedAt: T0,
      finishedAt: T0,
      history: [
        {
          attempt: 1,
          status: "passed",
          startedAt: T0,
          finishedAt: T0,
          durationMs: 5,
          exitCode: 0,
          reason: "ok",
        },
      ],
    };
    const state: PipelineState = {
      ...request.state,
      startedAt: T0,
      stages: { ...request.state.stages, a: passed },
    };

    const result = await runPipelineStages({ ...request, state });

    expect(result.status).toBe("done");
    expect(result.stagesRun).toEqual(["b"]);
    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]?.stage.id).toBe("b");
    expect(result.state.startedAt).toBe(T0);
    expect(result.state.stages["a"]?.attempts).toBe(1);
  });

  it("returns done without executing when every stage is complete", async () => {
    const { request, executor } = harness(twoStages(), []);
    const stages = Object.fromEntries(
      twoStages().map((def) => [
        def.id,
        { ...request.state.stages[def.id]!, status: "passed" as const },
      ]),
    );
    const state: PipelineState = { ...request.state, stages };

    const result = await runPipelineStages({ ...request, state });

    expect(result.status).toBe("done");
    expect(result.stagesRun).toEqual([]);
    expect(executor.requests).toHaveLength(0);
    expect(result.state.status).toBe("done");
    expect(result.state.finishedAt).not.toBeNull();
  });

  it("creates pending stage state for stages missing from the starting state", async () => {
    const base = harness(twoStages(), [okResult(), okResult()]);
    const state = createInitialPipelineState({
      storyId: "SH-1",
      specFile: "spec.md",
      stages: [stage("a", 0)],
      model: "test-model",
      thinking: "medium",
    });

    const result = await runPipelineStages({ ...base.request, state });

    expect(result.status).toBe("done");
    expect(result.state.stages["b"]?.status).toBe("passed");
    expect(result.state.stages["b"]?.attempts).toBe(1);
  });

  it("regresses on gate failure and carries findings to the target attempt", async () => {
    const findings = ["fix the login flow"];
    const usage = { tokens: 10, dollars: 0.25 };
    const { request, executor, saves } = harness(gatedStages(), [
      okResult({ usage }),
      gateFailResult(findings),
      okResult({ usage }),
      okResult({ usage }),
    ]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("done");
    expect(result.regressions).toBe(1);
    expect(result.stagesRun).toEqual(["a", "b", "a", "b"]);
    expect(executor.requests[2]?.stage.id).toBe("a");
    expect(executor.requests[2]?.attempt).toBe(2);
    expect(executor.requests[2]?.priorFindings).toEqual(findings);
    expect(result.state.stages["a"]?.attempts).toBe(2);
    expect(result.state.stages["b"]?.history[0]?.status).toBe("gate-failed");
    expect(result.state.stages["b"]?.history[0]?.findings).toEqual(findings);
    const regressed = saves.find(
      (state) => state.stages["a"]?.status === "pending" && state.regressions === 1,
    );
    expect(regressed?.stages["a"]?.findings).toEqual(findings);
    expect(regressed?.stages["a"]?.startedAt).toBeNull();
  });

  it("fails closed when the regression limit is exceeded", async () => {
    const { request } = harness(
      gatedStages(),
      [okResult(), gateFailResult(), okResult(), gateFailResult()],
      { maxRegressions: 1 },
    );

    const result = await runPipelineStages(request);

    expect(result.status).toBe("failed");
    expect(result.failure).toMatchObject({ code: "regression-limit-exceeded", stageId: "b" });
    expect(result.regressions).toBe(1);
    expect(result.stagesRun).toEqual(["a", "b", "a", "b"]);
    expect(result.state.status).toBe("failed");
  });

  it("uses DEFAULT_MAX_REGRESSIONS when maxRegressions is omitted", async () => {
    expect(DEFAULT_MAX_REGRESSIONS).toBe(3);
    const script: ScriptEntry[] = [okResult()];
    for (let index = 0; index < DEFAULT_MAX_REGRESSIONS + 1; index += 1) {
      script.push(gateFailResult(), okResult());
    }
    const { request } = harness(gatedStages(), script);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("regression-limit-exceeded");
    expect(result.regressions).toBe(DEFAULT_MAX_REGRESSIONS);
  });

  it("fails closed on gate failure without onFail", async () => {
    const stages = [stage("a", 0, { payloadGate: okGate, payloadGateName: "ok-gate" })];
    const { request } = harness(stages, [gateFailResult()]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("failed");
    expect(result.failure).toMatchObject({ code: "gate-failed-without-on-fail", stageId: "a" });
  });

  it("fails the run when a stage exits non-zero", async () => {
    const { request } = harness(twoStages(), [okResult({ exitCode: 3 })]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("failed");
    expect(result.failure).toMatchObject({ code: "stage-failed", stageId: "a" });
    expect(result.failure?.reason).toContain("exited with code 3");
    expect(result.state.stages["a"]?.status).toBe("failed");
    expect(result.state.stages["a"]?.history[0]?.status).toBe("failed");
    expect(result.stagesRun).toEqual(["a"]);
  });

  it("records timed-out attempts and fails the run", async () => {
    const { request } = harness(twoStages(), [
      okResult({ timedOut: true, output: null, exitCode: null }),
    ]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("stage-failed");
    expect(result.state.stages["a"]?.history[0]?.status).toBe("timed-out");
  });

  it("records parse errors on the attempt", async () => {
    const { request } = harness(twoStages(), [okResult({ parseError: "bad line", output: null })]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("failed");
    expect(result.state.stages["a"]?.history[0]?.status).toBe("parse-error");
    expect(result.state.stages["a"]?.history[0]?.parseError).toBe("bad line");
  });

  it.each([
    ["array", []],
    ["null", null],
    ["string", "nope"],
  ])("treats a %s payload as missing output", async (_label, payload) => {
    const { request } = harness(twoStages(), [okResult({ output: { payload } })]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("failed");
    expect(result.failure?.reason).toContain("did not produce validated output");
  });

  it("fails closed to needs-attention when a stage budget is exceeded", async () => {
    const stages = [stage("a", 0, { budget: { maxTokens: 5 } }), stage("b", 1)];
    const { request, executor } = harness(stages, [
      okResult({ usage: { tokens: 10, dollars: 0 } }),
    ]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure).toMatchObject({ code: "stage-budget-exceeded", stageId: "a" });
    expect(result.state.status).toBe("needs-attention");
    expect(executor.requests).toHaveLength(1);
    expect(result.state.stages["a"]?.status).toBe("passed");
  });

  it("fails closed when a budgeted stage reports no usage", async () => {
    const stages = [stage("a", 0, { budget: { maxDollars: 1 } })];
    const { request } = harness(stages, [okResult()]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure?.code).toBe("stage-budget-exceeded");
    expect(result.failure?.reason).toContain("no valid usage");
  });

  it("fails closed when the run budget is exceeded", async () => {
    const { request, executor } = harness(
      twoStages(),
      [okResult({ usage: { tokens: 1, dollars: 0.5 } })],
      { runBudget: { maxDollars: 0.25 } },
    );

    const result = await runPipelineStages(request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure).toMatchObject({ code: "run-budget-exceeded", stageId: "a" });
    expect(executor.requests).toHaveLength(1);
  });

  it("aborts before spawning when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { request, executor } = harness(twoStages(), [], { signal: controller.signal });

    const result = await runPipelineStages(request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure).toMatchObject({ code: "aborted", stageId: "a" });
    expect(executor.requests).toHaveLength(0);
    expect(result.stagesRun).toEqual([]);
    expect(result.state.status).toBe("needs-attention");
    expect(result.state.finishedAt).not.toBeNull();
  });

  it("stops between stages when the signal aborts mid-run", async () => {
    const controller = new AbortController();
    const { request, executor } = harness(
      twoStages(),
      [
        () => {
          controller.abort();
          return okResult();
        },
      ],
      { signal: controller.signal },
    );

    const result = await runPipelineStages(request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure).toMatchObject({ code: "aborted", stageId: "b" });
    expect(result.stagesRun).toEqual(["a"]);
    expect(executor.requests).toHaveLength(1);
    expect(result.state.stages["a"]?.status).toBe("passed");
  });

  it("treats an aborted execution result as needs-attention", async () => {
    const { request } = harness(twoStages(), [
      okResult({ aborted: true, output: null, exitCode: null }),
    ]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure?.code).toBe("aborted");
    expect(result.state.stages["a"]?.history[0]?.status).toBe("aborted");
  });

  it("turns an executor error into needs-attention with durable evidence", async () => {
    const { request, saves } = harness(twoStages(), [new Error("spawn exploded")]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure).toMatchObject({ code: "executor-error", stageId: "a" });
    expect(result.failure?.reason).toBe("spawn exploded");
    expect(result.state.stages["a"]?.status).toBe("failed");
    expect(result.state.stages["a"]?.history[0]).toMatchObject({
      attempt: 1,
      status: "failed",
      exitCode: null,
      durationMs: null,
      reason: "spawn exploded",
    });
    expect(result.stagesRun).toEqual(["a"]);
    expect(saves.at(-1)?.status).toBe("needs-attention");
  });

  it("stringifies non-Error executor throws", async () => {
    const { request } = harness(twoStages(), ["boom"]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure?.reason).toBe("boom");
  });

  it("serializes non-Error non-string executor throws", async () => {
    const { request } = harness(twoStages(), [
      () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercises unknown throws.
        throw 42;
      },
    ]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure?.reason).toBe("42");
  });

  it("saves state after every transition and before observer finish callbacks", async () => {
    const events: string[] = [];
    const base = harness([stage("a", 0)], []);
    const request: RunPipelineStagesRequest = {
      ...base.request,
      executor: {
        id: "stub",
        async execute() {
          events.push("execute:a");
          return okResult();
        },
      },
      saveState: async (state) => {
        events.push(`save:${state.status}:${String(state.currentStage)}`);
      },
      observer: {
        onStageStarted: (info) => events.push(`started:${info.stage.id}:${info.attempt}`),
        onStageFinished: (info) =>
          events.push(
            `finished:${info.stage.id}:${info.decision.kind}:${info.route.action}:${String(info.execution.exitCode)}`,
          ),
      },
    };

    const result = await runPipelineStages(request);

    expect(result.status).toBe("done");
    expect(events).toEqual([
      "started:a:1",
      "save:running:a",
      "execute:a",
      "save:running:a",
      "finished:a:passed:complete:0",
      "save:done:null",
    ]);
  });

  it("supports observers with only one callback", async () => {
    const started = vi.fn();
    const finished = vi.fn();
    const first = harness([stage("a", 0)], [okResult()], {
      observer: { onStageStarted: started },
    });
    await runPipelineStages(first.request);
    const second = harness([stage("a", 0)], [okResult()], {
      observer: { onStageFinished: finished },
    });
    await runPipelineStages(second.request);

    expect(started).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("throws RangeError for an empty stage list", async () => {
    const { request } = harness(twoStages(), []);

    await expect(runPipelineStages({ ...request, stages: [] })).rejects.toThrow(RangeError);
  });

  it.each([[-1], [1.5]])("throws RangeError for maxRegressions %s", async (maxRegressions) => {
    const { request } = harness(twoStages(), []);

    await expect(runPipelineStages({ ...request, maxRegressions })).rejects.toThrow(RangeError);
  });
});
