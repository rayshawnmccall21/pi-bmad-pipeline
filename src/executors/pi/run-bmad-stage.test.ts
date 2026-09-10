import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { buildEmissionProvenance } from "pi-bmad";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEBUG_LOG_PREFIX, PIPELINE_DEBUG_ENV_VAR } from "../../events/index.js";
import { createStageHandoff } from "../../security/stage-handoff.js";
import {
  BmadStageSpawnError,
  MAX_HEADLESS_JSONL_LINE_BYTES,
  MAX_STAGE_STDERR_CHARS,
  buildStageEnvironment,
  resolvePiBmadExtensionPath,
  runBmadStage,
  toBuildStageArgsRequest,
} from "./index.js";

import type { CompiledAgentStage } from "../../rundef/index.js";
import type {
  BmadStageChildProcess,
  BmadStageSpawn,
  BmadStageSpawnOptions,
  RunBmadStageRequest,
} from "./index.js";

const expectedDefaultKillEscalationMs = 10_000;
const piBmadRootDir = resolve(dirname(resolvePiBmadExtensionPath()), "..");

afterEach(() => {
  vi.unstubAllEnvs();
});

const loadFixtureEnvelope = (): Record<string, unknown> => {
  const line = readFileSync(
    join(piBmadRootDir, "contracts", "fixtures", "dev-story", "success.jsonl"),
    "utf8",
  ).trim();
  const parsed = JSON.parse(line) as {
    result: { details: { headlessOutput: Record<string, unknown> } };
  };
  return parsed.result.details.headlessOutput;
};

const stampedEnvelope = (emissionKey: string): Record<string, unknown> => {
  const fixture = loadFixtureEnvelope();
  const envelope = {
    ...fixture,
    payload: { ...(fixture["payload"] as Record<string, unknown>), storyId: "STORY-123" },
  };
  return { ...envelope, emissionProvenance: buildEmissionProvenance(emissionKey, envelope) };
};

const loadPi084Fixture = (
  emissionKey: string,
): { readonly events: readonly Record<string, unknown>[]; readonly stdout: string } => {
  const events = readFileSync(
    join(import.meta.dirname, "fixtures", "pi-0.84-headless.jsonl"),
    "utf8",
  )
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const toolEnd = events.at(-1) as {
    result: { details: { headlessOutput: Record<string, unknown> } };
  };
  const envelope = toolEnd.result.details.headlessOutput;
  toolEnd.result.details.headlessOutput = {
    ...envelope,
    emissionProvenance: buildEmissionProvenance(emissionKey, envelope),
  };
  return { events, stdout: `${events.map((event) => JSON.stringify(event)).join("\n")}\n` };
};

const toolEndLine = (headlessOutput: unknown): string =>
  `${JSON.stringify({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bmad_emit_result",
    isError: false,
    result: { details: { headlessOutput } },
  })}\n`;

const messageEndLine = (totalTokens: number, total: number): string =>
  `${JSON.stringify({
    type: "message_end",
    message: { role: "assistant", usage: { totalTokens, cost: { total } } },
  })}\n`;

const stage = (overrides: Partial<CompiledAgentStage> = {}): CompiledAgentStage => ({
  id: "dev-story",
  kind: "agent",
  workflow: "dev-story",
  agent: "dev",
  index: 0,
  timeoutSeconds: 1800,
  ...overrides,
});

const request = (overrides: Partial<RunBmadStageRequest> = {}): RunBmadStageRequest => ({
  stage: stage(),
  storyId: "STORY-123",
  specFile: "./specs/story-123.md",
  projectRoot: "/repo",
  attempt: 1,
  model: "zai/glm-5.3",
  thinking: "medium",
  signal: new AbortController().signal,
  ...overrides,
});

const handoff = (value: unknown) => {
  const normalized = createStageHandoff(value);
  expect(normalized).toBeDefined();
  return normalized!;
};

const createFakeChild = (): BmadStageChildProcess => {
  const child = new EventEmitter() as BmadStageChildProcess;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
};

const createSpawn = (child = createFakeChild()): [BmadStageSpawn, BmadStageChildProcess] => [
  vi.fn(() => child),
  child,
];

const close = (child: BmadStageChildProcess, code: number | null): void => {
  child.emit("close", code, null);
};

const writeStdout = (child: BmadStageChildProcess, text: string): void => {
  (child.stdout as PassThrough).write(text);
};

const writeStderr = (child: BmadStageChildProcess, text: string): void => {
  (child.stderr as PassThrough).write(text);
};

describe("stage child environment", () => {
  it("preserves ordinary and provider env while removing inherited Pi control state", () => {
    const parentEnv = {
      PATH: "/usr/bin",
      HOME: "/home/test",
      LANG: "en_US.UTF-8",
      ZAI_API_KEY: "zai-key",
      OPENROUTER_API_KEY: "openrouter-key",
      PI_SESSION_ID: "session-id",
      PI_SESSION_FILE: "/tmp/session.json",
      PI_PROVIDER: "inherited-provider",
      PI_MODEL: "inherited-model",
      PI_REASONING_LEVEL: "high",
      PI_SUBAGENT_PARENT_SESSION: "parent-session",
      PI_BMAD_RUN_ID: "inherited-run",
      PI_BMAD_EMISSION_KEY: "inherited-emission",
      PI_PACKAGE_DIR: "/inherited/package",
      PI_EXTENSIONS: "/inherited/extension.ts",
      PI_SUBAGENT_CHILD: "child",
      PI_SUBAGENT_CHILD_TOKEN: "child-token",
      PI_CODING_AGENT_DIR: "/inherited/agent",
    };

    expect(buildStageEnvironment(parentEnv, {})).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/test",
      LANG: "en_US.UTF-8",
      ZAI_API_KEY: "zai-key",
      OPENROUTER_API_KEY: "openrouter-key",
      PI_TELEMETRY: "0",
    });
  });

  it("lets the fresh invocation win, restores its run contract, and forces telemetry off", () => {
    const parentEnv = {
      PATH: "/parent/bin",
      PI_BMAD_RUN_ID: "inherited-run",
      PI_BMAD_EMISSION_KEY: "inherited-emission",
      PI_OFFLINE: "0",
      PI_TELEMETRY: "1",
      PI_CODING_AGENT_DIR: "/inherited/agent",
    };
    const invocationEnv = {
      PATH: "/invocation/bin",
      PI_BMAD_RUN_ID: "fresh-run",
      PI_BMAD_EMISSION_KEY: "fresh-emission",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "1",
      PI_CODING_AGENT_DIR: "/reviewed/agent",
    };
    const parentBefore = { ...parentEnv };
    const invocationBefore = { ...invocationEnv };

    const result = buildStageEnvironment(parentEnv, invocationEnv);

    expect(result).toEqual({
      PATH: "/invocation/bin",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_BMAD_RUN_ID: "fresh-run",
      PI_BMAD_EMISSION_KEY: "fresh-emission",
      PI_CODING_AGENT_DIR: "/reviewed/agent",
    });
    expect(result).not.toBe(parentEnv);
    expect(result).not.toBe(invocationEnv);
    expect(parentEnv).toEqual(parentBefore);
    expect(invocationEnv).toEqual(invocationBefore);
  });
});

describe("run BMAD stage", () => {
  it("maps requests to build-stage-args requests", () => {
    const upstreamHandoff = handoff({ locations: ["src/example.ts:42"] });
    const input = request({
      priorFindings: ["a"],
      upstreamHandoff,
      piBin: "pix",
      piBmadExtensionPath: "/deps/pi-bmad/extensions/pi-bmad.ts",
      emissionKey: "key-1",
      runId: "run-9",
    });

    const mapped = toBuildStageArgsRequest(input);
    expect(mapped).toEqual({
      stage: input.stage,
      storyId: "STORY-123",
      specFile: "./specs/story-123.md",
      projectRoot: "/repo",
      attempt: 1,
      model: "zai/glm-5.3",
      thinking: "medium",
      priorFindings: ["a"],
      upstreamHandoff,
      piBin: "pix",
      piBmadExtensionPath: "/deps/pi-bmad/extensions/pi-bmad.ts",
      emissionKey: "key-1",
      runId: "run-9",
    });
    expect(mapped.upstreamHandoff).toBe(upstreamHandoff);
  });

  it("omits optional build-stage-args fields when absent", () => {
    expect(toBuildStageArgsRequest(request())).not.toHaveProperty("priorFindings");
    expect(toBuildStageArgsRequest(request())).not.toHaveProperty("upstreamHandoff");
    expect(toBuildStageArgsRequest(request())).not.toHaveProperty("piBin");
    expect(toBuildStageArgsRequest(request())).not.toHaveProperty("runId");
  });

  it("resolves the pi-bmad extension path when not provided", () => {
    const mapped = toBuildStageArgsRequest(request());

    expect(mapped.piBmadExtensionPath).toContain("pi-bmad");
  });

  it("generates a fresh emission key per run when not provided", () => {
    const first = toBuildStageArgsRequest(request());
    const second = toBuildStageArgsRequest(request());

    expect(first.emissionKey.trim().length).toBeGreaterThan(0);
    expect(first.emissionKey).not.toBe(second.emissionKey);
  });

  it("spawns with built bin, args, cwd, and a sanitized child environment", async () => {
    vi.stubEnv("ZAI_API_KEY", "caller-owned-provider-key");
    vi.stubEnv("PI_SESSION_ID", "inherited-session");
    vi.stubEnv("PI_SUBAGENT_CHILD_TOKEN", "inherited-child-token");
    vi.stubEnv("PI_CODING_AGENT_DIR", "/inherited/agent");
    vi.stubEnv("PI_TELEMETRY", "1");
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(
      request({
        spawn,
        piBin: "pix",
        piBmadExtensionPath: "/deps/pi-bmad/extensions/pi-bmad.ts",
        emissionKey: "key-1",
      }),
    );
    close(child, 0);
    await promise;

    expect(spawn).toHaveBeenCalledWith(
      "pix",
      expect.arrayContaining(["--bmad-workflow", "dev-story", "--bmad-story", "STORY-123"]),
      expect.objectContaining({ cwd: "/repo" }) as BmadStageSpawnOptions,
    );
    const options = vi.mocked(spawn).mock.calls[0]?.[2];
    expect(options?.env).toEqual(
      expect.objectContaining({
        ZAI_API_KEY: "caller-owned-provider-key",
        PI_BMAD_RUN_ID: "STORY-123.dev-story.1",
        PI_BMAD_EMISSION_KEY: "key-1",
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
      }),
    );
    expect(options?.env).not.toHaveProperty("PI_SESSION_ID");
    expect(options?.env).not.toHaveProperty("PI_SUBAGENT_CHILD_TOKEN");
    expect(options?.env).not.toHaveProperty("PI_CODING_AGENT_DIR");
  });

  it("returns the gated headless envelope from tool_execution_end, not the last record", async () => {
    const [spawn, child] = createSpawn();
    const envelope = stampedEnvelope("key-1");

    const promise = runBmadStage(request({ spawn, emissionKey: "key-1" }));
    writeStdout(child, `${toolEndLine(envelope)}{"type":"agent_end"}\n`);
    close(child, 0);

    await expect(promise).resolves.toMatchObject({ output: envelope, exitCode: 0 });
  });

  it("accepts the Pi 0.84 delta-only/update, authoritative-end, headless fixture", async () => {
    const [spawn, child] = createSpawn();
    const fixture = loadPi084Fixture("key-1");

    expect(fixture.events[0]).not.toHaveProperty("message");
    expect(fixture.events[0]).toMatchObject({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "working " },
    });
    expect(fixture.events[2]).toMatchObject({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "working done" }] },
    });
    expect(fixture.events[3]).toMatchObject({
      type: "tool_execution_end",
      result: { details: { headlessOutput: { workflow: "dev-story" } } },
    });

    const promise = runBmadStage(request({ spawn, emissionKey: "key-1" }));
    writeStdout(child, fixture.stdout);
    close(child, 0);

    await expect(promise).resolves.toMatchObject({
      output: { workflow: "dev-story", payload: { storyId: "STORY-123" } },
      usage: { tokens: 42, dollars: 0.125 },
      exitCode: 0,
    });
  });

  it("rejects a valid emitted dev-story envelope for another story on exit 0", async () => {
    const [spawn, child] = createSpawn();
    const envelope = loadFixtureEnvelope();
    const forged = {
      ...envelope,
      payload: {
        storyId: "FORGED-999",
        testsAdded: 4,
        filesChanged: ["src/contracts/index.ts"],
        testsPassed: true,
        typecheckPassed: true,
        lintPassed: true,
      },
    };
    const stamped = {
      ...forged,
      emissionProvenance: buildEmissionProvenance("key-1", forged),
    };

    const promise = runBmadStage(request({ spawn, emissionKey: "key-1" }));
    writeStdout(child, toolEndLine(stamped));
    close(child, 0);

    await expect(promise).resolves.toMatchObject({
      output: null,
      exitCode: 0,
      parseError:
        'Headless terminal output payload storyId "FORGED-999" does not match requested story identity "STORY-123".',
    });
  });

  it("spawns the child with stdin ignored so print-mode children see EOF", async () => {
    const [spawn, child] = createSpawn();
    const promise = runBmadStage(request({ spawn }));

    close(child, 0);
    await promise;

    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it("fails closed when the terminal envelope is forged (bare last line)", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, emissionKey: "key-1" }));
    writeStdout(child, `${JSON.stringify(loadFixtureEnvelope())}\n`);
    close(child, 0);
    const result = await promise;

    expect(result.output).toBeNull();
    expect(result.parseError).toMatch(/No headless terminal output/u);
  });

  it("fails closed when the envelope is stamped with a different emission key", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, emissionKey: "key-1" }));
    writeStdout(child, toolEndLine(stampedEnvelope("other-key")));
    close(child, 0);
    const result = await promise;

    expect(result.output).toBeNull();
    expect(result.parseError).toMatch(/provenance/u);
  });

  it("aggregates assistant usage from message_end events", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, emissionKey: "key-1" }));
    writeStdout(child, `${messageEndLine(10, 0.25)}${messageEndLine(5, 0.5)}`);
    writeStdout(child, toolEndLine(stampedEnvelope("key-1")));
    close(child, 0);

    await expect(promise).resolves.toMatchObject({ usage: { tokens: 15, dollars: 0.75 } });
  });

  it("omits invalid usage", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, emissionKey: "key-1" }));
    writeStdout(
      child,
      '{"type":"message_end","message":{"role":"assistant","usage":{"totalTokens":-1,"cost":{"total":0}}}}\n',
    );
    writeStdout(child, toolEndLine(stampedEnvelope("key-1")));
    close(child, 0);

    expect(await promise).not.toHaveProperty("usage");
  });

  it("captures the first JSONL issue as parseError", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn }));
    writeStdout(child, '{bad}\n{"ok":true}\n');
    close(child, 0);

    expect((await promise).parseError).toMatch(/^Invalid JSONL on line 1:/u);
  });

  it("kills on parser overflow, ignores later output and child errors, and escalates", async () => {
    vi.useFakeTimers();
    const [spawn, child] = createSpawn();
    const promise = runBmadStage(request({ spawn, emissionKey: "key-1", killEscalationMs: 5 }));

    writeStdout(child, toolEndLine(stampedEnvelope("key-1")));
    expect(() => {
      writeStdout(child, "x".repeat(MAX_HEADLESS_JSONL_LINE_BYTES + 1));
      writeStdout(child, "{}\n".repeat(100));
      child.emit("error", new Error("late process error"));
    }).not.toThrow();
    expect(killSignals(child)).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(5);
    expect(killSignals(child)).toEqual(["SIGTERM", "SIGKILL"]);
    close(child, 0);

    await expect(promise).resolves.toMatchObject({
      output: null,
      exitCode: 0,
      parseError: `JSONL line exceeded ${String(MAX_HEADLESS_JSONL_LINE_BYTES)} bytes.`,
    });
    vi.useRealTimers();
  });

  it.each([
    ["stdout", "Child stdout stream error."],
    ["stderr", "Child stderr stream error."],
  ] as const)("fails closed and escalates on %s stream error", async (streamName, parseError) => {
    vi.useFakeTimers();
    const [spawn, child] = createSpawn();
    const promise = runBmadStage(request({ spawn, killEscalationMs: 5 }));

    expect(() =>
      child[streamName].emit("error", new Error("unbounded secret detail")),
    ).not.toThrow();
    expect(killSignals(child)).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(5);
    expect(killSignals(child)).toEqual(["SIGTERM", "SIGKILL"]);
    close(child, 0);

    await expect(promise).resolves.toMatchObject({ output: null, exitCode: 0, parseError });
    vi.useRealTimers();
  });

  it("cleans up child and stream listeners after settlement", async () => {
    const [spawn, child] = createSpawn();
    const promise = runBmadStage(request({ spawn }));

    close(child, 0);
    await promise;

    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stdout.listenerCount("error")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("error")).toBe(0);
  });

  it("uses stderr fallback for nonzero exit with no output", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn }));
    writeStderr(child, "boom");
    close(child, 1);

    await expect(promise).resolves.toMatchObject({ parseError: "Child stderr: boom" });
  });

  it("preserves split UTF-8 in stderr diagnostics", async () => {
    const [spawn, child] = createSpawn();
    const encoded = Buffer.from("failure: €");

    const promise = runBmadStage(request({ spawn }));
    child.stderr.emit("data", encoded.subarray(0, encoded.length - 2));
    child.stderr.emit("data", encoded.subarray(encoded.length - 2));
    close(child, 1);

    await expect(promise).resolves.toMatchObject({ parseError: "Child stderr: failure: €" });
  });

  it("caps captured stderr", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn }));
    writeStderr(child, "x".repeat(MAX_STAGE_STDERR_CHARS + 10));
    close(child, 1);

    expect((await promise).parseError).toHaveLength(
      "Child stderr: ".length + MAX_STAGE_STDERR_CHARS,
    );
  });

  it("returns child exit code from close", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn }));
    close(child, 7);

    await expect(promise).resolves.toMatchObject({ exitCode: 7 });
  });

  it("returns non-negative duration using injected clock", async () => {
    const [spawn, child] = createSpawn();
    const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(90);

    const promise = runBmadStage(request({ spawn, now }));
    close(child, 0);

    await expect(promise).resolves.toMatchObject({ durationMs: 0 });
  });

  it("marks timedOut and kills child on timeout", async () => {
    vi.useFakeTimers();
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, timeoutMs: 1 }));
    await vi.advanceTimersByTimeAsync(1);
    close(child, null);

    await expect(promise).resolves.toMatchObject({ timedOut: true });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- fake child kill is a vi.fn.
    expect(vi.mocked(child.kill)).toHaveBeenCalledWith("SIGTERM");
    vi.useRealTimers();
  });

  it("marks aborted and kills child on abort", async () => {
    const controller = new AbortController();
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, signal: controller.signal }));
    controller.abort();
    close(child, null);

    await expect(promise).resolves.toMatchObject({ aborted: true });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- fake child kill is a vi.fn.
    expect(vi.mocked(child.kill)).toHaveBeenCalledWith("SIGTERM");
  });

  it("marks already aborted requests", async () => {
    const controller = new AbortController();
    const [spawn, child] = createSpawn();
    controller.abort();

    const promise = runBmadStage(request({ spawn, signal: controller.signal }));
    close(child, null);

    await expect(promise).resolves.toMatchObject({ aborted: true });
  });

  it("rejects with BmadStageSpawnError when spawn throws", async () => {
    const spawn = vi.fn(() => {
      throw new Error("missing binary");
    });

    await expect(runBmadStage(request({ spawn }))).rejects.toBeInstanceOf(BmadStageSpawnError);
  });

  it("rejects with BmadStageSpawnError on child error", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn }));
    child.emit("error", new Error("spawn failed"));
    close(child, 1);

    await expect(promise).rejects.toBeInstanceOf(BmadStageSpawnError);
  });

  it("rejects invalid timeoutMs", () => {
    expect(() => runBmadStage(request({ timeoutMs: 0 }))).toThrow(RangeError);
  });

  it("omits optional result fields when absent", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, emissionKey: "key-1" }));
    writeStdout(child, toolEndLine(stampedEnvelope("key-1")));
    close(child, 0);
    const result = await promise;

    expect(result).not.toHaveProperty("parseError");
    expect(result).not.toHaveProperty("usage");
    expect(result).not.toHaveProperty("timedOut");
    expect(result).not.toHaveProperty("aborted");
  });

  it("does not mutate the request, prior findings, or upstream handoff", async () => {
    const findings = ["a"];
    const upstreamHandoff = handoff({ locations: ["src/example.ts:42"] });
    const [spawn, child] = createSpawn();
    const input = request({ spawn, priorFindings: findings, upstreamHandoff });
    const before = JSON.stringify({ input, findings, upstreamHandoff });

    const promise = runBmadStage(input);
    close(child, 0);
    await promise;

    expect(JSON.stringify({ input, findings, upstreamHandoff })).toBe(before);
  });
});

const killSignals = (child: BmadStageChildProcess): readonly unknown[] =>
  // eslint-disable-next-line @typescript-eslint/unbound-method -- fake child kill is a vi.fn.
  vi.mocked(child.kill).mock.calls.map((call: readonly unknown[]) => call[0]);

describe("run BMAD stage SIGTERM-to-SIGKILL escalation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("escalates to SIGKILL when the child ignores SIGTERM past the grace period", async () => {
    vi.useFakeTimers();
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, timeoutMs: 1 }));
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(expectedDefaultKillEscalationMs);
    close(child, null);

    await expect(promise).resolves.toMatchObject({ timedOut: true });
    expect(killSignals(child)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("honors an injected killEscalationMs grace period", async () => {
    vi.useFakeTimers();
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, timeoutMs: 1, killEscalationMs: 5 }));
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(4);
    expect(killSignals(child)).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1);
    close(child, null);

    await expect(promise).resolves.toMatchObject({ timedOut: true });
    expect(killSignals(child)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("preserves timeout classification and escalation when a late child error races termination", async () => {
    vi.useFakeTimers();
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, timeoutMs: 1, killEscalationMs: 5 }));
    const settlement = promise.then(
      (result) => ({ kind: "resolved" as const, result }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    await vi.advanceTimersByTimeAsync(1);
    child.emit("error", new Error("late process error"));
    await vi.advanceTimersByTimeAsync(5);
    close(child, null);

    expect(killSignals(child)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(await settlement).toMatchObject({
      kind: "resolved",
      result: { output: null, exitCode: null, timedOut: true },
    });
  });

  it("never sends SIGKILL when the child exits within the grace period", async () => {
    vi.useFakeTimers();
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, timeoutMs: 1 }));
    await vi.advanceTimersByTimeAsync(1);
    close(child, null);
    await vi.advanceTimersByTimeAsync(expectedDefaultKillEscalationMs);

    await expect(promise).resolves.toMatchObject({ timedOut: true });
    expect(killSignals(child)).toEqual(["SIGTERM"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("escalates aborted children that ignore SIGTERM", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, signal: controller.signal }));
    controller.abort();
    await vi.advanceTimersByTimeAsync(expectedDefaultKillEscalationMs);
    close(child, null);

    await expect(promise).resolves.toMatchObject({ aborted: true });
    expect(killSignals(child)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("schedules a single escalation when timeout and abort both fire", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, signal: controller.signal, timeoutMs: 1 }));
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(expectedDefaultKillEscalationMs);
    close(child, null);

    await expect(promise).resolves.toMatchObject({ timedOut: true, aborted: true });
    expect(killSignals(child)).toEqual(["SIGTERM", "SIGTERM", "SIGKILL"]);
  });

  it("leaves no timers behind on normal close", async () => {
    vi.useFakeTimers();
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn }));
    close(child, 0);
    await promise;

    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 1.5, -1])("rejects invalid killEscalationMs %j", (killEscalationMs) => {
    expect(() => runBmadStage(request({ killEscalationMs }))).toThrow(
      "killEscalationMs must be a positive integer.",
    );
  });
});

const captureDebug = () => {
  vi.stubEnv(PIPELINE_DEBUG_ENV_VAR, "1");
  return vi.spyOn(process.stderr, "write").mockReturnValue(true);
};

const debugEvents = (write: ReturnType<typeof captureDebug>): Record<string, unknown>[] =>
  write.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith(`${DEBUG_LOG_PREFIX} `))
    .map((line) => JSON.parse(line.slice(DEBUG_LOG_PREFIX.length + 1)) as Record<string, unknown>);

describe("run BMAD stage debug logging", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("emits stage.spawn argv context without leaking the emission key", async () => {
    const write = captureDebug();
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(
      request({ spawn, emissionKey: "emission-key-secret-1", runId: "run-9" }),
    );
    close(child, 0);
    await promise;

    const event = debugEvents(write).find((entry) => entry["event"] === "stage.spawn");
    expect(event).toMatchObject({
      storyId: "STORY-123",
      stageId: "dev-story",
      workflow: "dev-story",
      attempt: 1,
      bin: "pi",
      cwd: "/repo",
      runId: "run-9",
      timeoutMs: 1_800_000,
    });
    expect(event?.["args"]).toEqual(expect.arrayContaining(["--bmad-story", "STORY-123"]));
    const rendered = write.mock.calls.map((call) => String(call[0])).join("");
    expect(rendered).not.toContain("emission-key-secret-1");
  });

  it("spawns and debug-logs only the redacted upstream handoff", async () => {
    const fakeSecret = "Bearer fake-token-1234567890";
    const upstreamHandoff = handoff({ nested: { token: fakeSecret } });
    const write = captureDebug();
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, upstreamHandoff }));
    close(child, 0);
    await promise;

    const spawnedArgs = vi.mocked(spawn).mock.calls[0]?.[1];
    const spawnEvent = debugEvents(write).find((entry) => entry["event"] === "stage.spawn");
    const rendered = `${JSON.stringify(spawnedArgs)}${JSON.stringify(spawnEvent?.["args"])}`;
    expect(upstreamHandoff).toContain('"token":"[REDACTED]"');
    expect(rendered).toContain('\\"token\\":\\"[REDACTED]\\"');
    expect(rendered).not.toContain(fakeSecret);
  });

  it("emits an accepted stage.envelope-gate verdict without a failure reason", async () => {
    const write = captureDebug();
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, emissionKey: "key-1" }));
    writeStdout(child, toolEndLine(stampedEnvelope("key-1")));
    close(child, 0);
    await promise;

    const event = debugEvents(write).find((entry) => entry["event"] === "stage.envelope-gate");
    expect(event).toMatchObject({
      storyId: "STORY-123",
      stageId: "dev-story",
      attempt: 1,
      accepted: true,
      exitCode: 0,
      timedOut: false,
      aborted: false,
    });
    expect(event).not.toHaveProperty("reason");
  });

  it("emits a rejected stage.envelope-gate verdict with the fail-closed reason", async () => {
    const write = captureDebug();
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, emissionKey: "key-1" }));
    writeStdout(child, toolEndLine(stampedEnvelope("other-key")));
    close(child, 0);
    await promise;

    const event = debugEvents(write).find((entry) => entry["event"] === "stage.envelope-gate");
    expect(event).toMatchObject({ accepted: false, exitCode: 0 });
    expect(String(event?.["reason"])).toMatch(/provenance/u);
  });
});
