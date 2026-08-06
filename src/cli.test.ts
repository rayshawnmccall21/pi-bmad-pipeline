import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { runPipelineAction, type RunPipelineActionRequest } from "./actions/index.js";
import { generatePipelineAuditReport } from "./audit/index.js";
import { CLI_USAGE_LINES } from "./cli-args.js";
import { CLI_EXIT_BLOCKED, CLI_EXIT_ERROR, CLI_EXIT_OK } from "./cli-output.js";
import {
  STATE_NOT_FOUND_ERROR_CODE,
  defaultRunCliDeps,
  isMainModule,
  runCli,
  versionBanner,
  type RunCliDeps,
  RUNDEF_UNAVAILABLE_ERROR_CODE,
} from "./cli.js";
import { serializePipelineEvent } from "./events/index.js";
import {
  ensureStoryWorktree,
  evaluateMergeGate,
  type EvaluateMergeGateRequest,
  type MergeGateEvaluation,
} from "./git/index.js";
import { type CompiledStageDef } from "./rundef/index.js";
import { loadHarnessEvidence, type HarnessEvidenceReport } from "./security/index.js";
import {
  createInitialPipelineState,
  loadCurrentRunPointer,
  loadPipelineState,
  type PipelineState,
  type RunResultStatus,
} from "./state/index.js";

const fixedIso = "2026-08-05T12:34:56.000Z";

const sinkFixture = (): { lines: string[]; write: (line: string) => void } => {
  const lines: string[] = [];
  return { lines, write: (line: string): void => void lines.push(line) };
};

const parseLine = (line: string): Record<string, unknown> =>
  JSON.parse(line) as Record<string, unknown>;

const stateFixture = (overrides: Partial<PipelineState> = {}): PipelineState => ({
  ...createInitialPipelineState({
    storyId: "S-1",
    specFile: "docs/spec.md",
    worktreePath: "/wt/s-1",
    branch: "story/s-1",
    stages: [],
    model: "model-1",
    thinking: "high",
  }),
  ...overrides,
});

const stageDefFixture = (overrides: Partial<CompiledStageDef> = {}): CompiledStageDef =>
  Object.freeze({
    id: "stage-1",
    kind: "agent",
    workflow: "wf",
    agent: "dev",
    index: 0,
    timeoutSeconds: 1800,
    ...overrides,
  });

const evidenceFixture = (passed: boolean): HarnessEvidenceReport =>
  Object.freeze({
    projectRoot: "/wt/s-1",
    startedAt: fixedIso,
    finishedAt: fixedIso,
    passed,
    commands: Object.freeze([
      Object.freeze({
        name: "test" as const,
        command: "npm",
        args: Object.freeze(["test"]),
        status: passed ? ("passed" as const) : ("failed" as const),
        exitCode: passed ? 0 : 1,
        durationMs: 10,
        stdout: "",
        stderr: "",
      }),
    ]),
  });

interface DepsFixture {
  readonly deps: Partial<RunCliDeps>;
  readonly stdout: ReturnType<typeof sinkFixture>;
  readonly stderr: ReturnType<typeof sinkFixture>;
}

const depsFixture = (overrides: Partial<RunCliDeps> = {}): DepsFixture => {
  const stdout = sinkFixture();
  const stderr = sinkFixture();
  return {
    stdout,
    stderr,
    deps: {
      stdout: { write: stdout.write },
      stderr: { write: stderr.write },
      cwd: () => "/fixture-cwd",
      env: { BMAD_PIPELINE_MODEL: "env-model" },
      ...overrides,
    },
  };
};

describe("versionBanner", () => {
  it("includes the package name and version", () => {
    expect(versionBanner()).toBe("pi-bmad-pipeline v0.1.0");
  });
});

describe("runCli usage handling", () => {
  it("writes the parse error and usage to stderr and returns 1", async () => {
    const fixture = depsFixture();
    const code = await runCli(["bogus"], fixture.deps);
    expect(code).toBe(CLI_EXIT_ERROR);
    expect(fixture.stdout.lines).toEqual([]);
    expect(fixture.stderr.lines[0]).toContain("unknown-command");
    expect(fixture.stderr.lines.slice(1)).toEqual([...CLI_USAGE_LINES]);
  });

  it("writes usage to stdout for help and returns 0", async () => {
    const fixture = depsFixture();
    const code = await runCli(["--help"], fixture.deps);
    expect(code).toBe(CLI_EXIT_OK);
    expect(fixture.stdout.lines).toEqual([...CLI_USAGE_LINES]);
  });

  it("writes the version banner to stdout for version and returns 0", async () => {
    const fixture = depsFixture();
    const code = await runCli(["--version"], fixture.deps);
    expect(code).toBe(CLI_EXIT_OK);
    expect(fixture.stdout.lines).toEqual([versionBanner()]);
  });

  it("redacts thrown errors to stderr and returns 1", async () => {
    const fixture = depsFixture({
      runPipeline: () => {
        throw new Error("boom Bearer abcdef1234567890abcdef1234567890");
      },
    });
    const code = await runCli(
      ["run", "sdlc", "--story-id", "S-1", "--spec-file", "spec.md"],
      fixture.deps,
    );
    expect(code).toBe(CLI_EXIT_ERROR);
    expect(fixture.stderr.lines[0]).toContain("boom");
    expect(fixture.stderr.lines[0]).toContain("[REDACTED]");
    expect(fixture.stderr.lines[0]).not.toContain("abcdef1234567890");
  });
});

describe("runCli run command", () => {
  const runResultFixture = (status: RunResultStatus) =>
    Object.freeze({
      storyId: "S-1",
      specFile: "docs/spec.md",
      action: "run",
      status,
      stagesRun: Object.freeze([]),
      regressions: 0,
      durationMs: 7,
    });

  const capturewrap = (
    requests: RunPipelineActionRequest[],
    status: RunResultStatus,
  ): RunCliDeps["runPipeline"] => {
    return (request) => {
      requests.push(request);
      request.sink?.write(
        serializePipelineEvent({
          event: "progress",
          ts: fixedIso,
          storyId: request.storyId,
          message: "hello",
        }),
      );
      return Promise.resolve(runResultFixture(status));
    };
  };

  it("forwards a minimal command with defaults from injected deps", async () => {
    const requests: RunPipelineActionRequest[] = [];
    const fixture = depsFixture({
      runPipeline: capturewrap(requests, "passed"),
    });
    const code = await runCli(
      ["run", "sdlc", "--story-id", "S-1", "--spec-file", "spec.md"],
      fixture.deps,
    );
    expect(code).toBe(CLI_EXIT_OK);
    const request = requests[0]!;
    expect(request.rundefId).toBe("sdlc");
    expect(request.storyId).toBe("S-1");
    expect(request.specFile).toBe("spec.md");
    expect(request.projectRoot).toBe("/fixture-cwd");
    expect(request.openPr).toBe(true);
    expect(request.env).toEqual({ BMAD_PIPELINE_MODEL: "env-model" });
    expect(request.model).toBeUndefined();
    expect(request.thinking).toBeUndefined();
    expect(request.maxRegressions).toBeUndefined();
  });

  it("forwards explicit options and maps a blocked status to exit 2", async () => {
    const requests: RunPipelineActionRequest[] = [];
    const fixture = depsFixture({
      runPipeline: capturewrap(requests, "needs-attention"),
    });
    const code = await runCli(
      [
        "run",
        "sdlc",
        "--story-id",
        "S-1",
        "--spec-file",
        "spec.md",
        "--project-root",
        "/repo",
        "--model",
        "model-1",
        "--thinking",
        "low",
        "--max-regressions",
        "2",
        "--no-pr",
      ],
      fixture.deps,
    );
    expect(code).toBe(CLI_EXIT_BLOCKED);
    const request = requests[0]!;
    expect(request.projectRoot).toBe("/repo");
    expect(request.model).toBe("model-1");
    expect(request.thinking).toBe("low");
    expect(request.maxRegressions).toBe(2);
    expect(request.openPr).toBe(false);
  });

  it("emits raw JSONL event lines on stdout with --jsonl", async () => {
    const requests: RunPipelineActionRequest[] = [];
    const fixture = depsFixture({
      runPipeline: capturewrap(requests, "passed"),
    });
    await runCli(
      ["run", "sdlc", "--story-id", "S-1", "--spec-file", "spec.md", "--jsonl"],
      fixture.deps,
    );
    expect(fixture.stdout.lines).toHaveLength(1);
    expect(parseLine(fixture.stdout.lines[0]!)).toEqual({
      event: "progress",
      ts: fixedIso,
      storyId: "S-1",
      message: "hello",
    });
  });

  it("emits human-readable lines derived from the same events by default", async () => {
    const requests: RunPipelineActionRequest[] = [];
    const fixture = depsFixture({
      runPipeline: capturewrap(requests, "passed"),
    });
    await runCli(["run", "sdlc", "--story-id", "S-1", "--spec-file", "spec.md"], fixture.deps);
    expect(fixture.stdout.lines).toEqual(["12:34:56 [S-1] progress message=hello"]);
  });
});

describe("runCli audit command", () => {
  const auditDeps = (
    state: PipelineState | undefined,
    evidence: HarnessEvidenceReport | undefined,
  ): DepsFixture =>
    depsFixture({
      loadState: () => Promise.resolve(state),
      loadEvidence: () => Promise.resolve(evidence),
      compileStages: () => Promise.resolve([]),
      generateAudit: generatePipelineAuditReport,
    });

  it("emits a state-not-found error event and returns 2 when state is missing", async () => {
    const fixture = auditDeps(undefined, undefined);
    const code = await runCli(["audit", "--story-id", "S-1"], fixture.deps);
    expect(code).toBe(CLI_EXIT_BLOCKED);
    const event = parseLine(fixture.stdout.lines[0]!);
    expect(event["event"]).toBe("error");
    expect(event["code"]).toBe(STATE_NOT_FOUND_ERROR_CODE);
    expect(event["storyId"]).toBe("S-1");
  });

  it("compiles the default sdlc rundef and joins stage summaries into the report", async () => {
    const stageDefs = Object.freeze([
      stageDefFixture({ id: "alpha", index: 0, workflow: "wf-a", agent: "dev" }),
      stageDefFixture({ id: "beta", index: 1, workflow: "wf-b", agent: "tea" }),
    ]);
    const seen: string[] = [];
    const state = stateFixture({ status: "done" });
    const fixture = depsFixture({
      loadState: () => Promise.resolve(state),
      loadEvidence: () => Promise.resolve(undefined),
      compileStages: (projectRoot, rundefId) => {
        seen.push(`${projectRoot}:${rundefId}`);
        return Promise.resolve(stageDefs);
      },
      generateAudit: generatePipelineAuditReport,
    });

    const code = await runCli(["audit", "--story-id", "S-1"], fixture.deps);

    expect(code).toBe(CLI_EXIT_OK);
    expect(seen).toEqual(["/fixture-cwd:sdlc"]);
    const report = parseLine(fixture.stdout.lines[0]!);
    expect(report["stages"]).toEqual([
      expect.objectContaining({ id: "alpha", workflow: "wf-a", agent: "dev" }),
      expect.objectContaining({ id: "beta", workflow: "wf-b", agent: "tea" }),
    ]);
  });

  it("passes an explicit --rundef id to the stage compiler", async () => {
    const seen: string[] = [];
    const fixture = depsFixture({
      loadState: () => Promise.resolve(stateFixture({ status: "done" })),
      loadEvidence: () => Promise.resolve(undefined),
      compileStages: (_projectRoot, rundefId) => {
        seen.push(rundefId);
        return Promise.resolve([]);
      },
      generateAudit: generatePipelineAuditReport,
    });

    await runCli(["audit", "--story-id", "S-1", "--rundef", "custom"], fixture.deps);

    expect(seen).toEqual(["custom"]);
  });

  it("fails closed with a rundef-unavailable error event when compilation fails", async () => {
    const fixture = depsFixture({
      loadState: () => Promise.resolve(stateFixture({ status: "done" })),
      loadEvidence: () => Promise.resolve(undefined),
      compileStages: () => Promise.reject(new Error("no such rundef")),
      generateAudit: generatePipelineAuditReport,
    });

    const code = await runCli(["audit", "--story-id", "S-1"], fixture.deps);

    expect(code).toBe(CLI_EXIT_BLOCKED);
    const event = parseLine(fixture.stdout.lines[0]!);
    expect(event["event"]).toBe("error");
    expect(event["code"]).toBe(RUNDEF_UNAVAILABLE_ERROR_CODE);
    expect(event["message"]).toContain("no such rundef");
  });

  it("prints a passing audit report and returns 0 for a done run", async () => {
    const state = stateFixture({
      status: "done",
      startedAt: "2026-08-05T12:00:00.000Z",
      finishedAt: "2026-08-05T12:00:10.000Z",
    });
    const fixture = auditDeps(state, evidenceFixture(true));
    const code = await runCli(["audit", "--story-id", "S-1"], fixture.deps);
    expect(code).toBe(CLI_EXIT_OK);
    const report = parseLine(fixture.stdout.lines[0]!);
    expect(report["status"]).toBe("passed");
    expect(report["storyId"]).toBe("S-1");
    expect(report["durationMs"]).toBe(10_000);
    expect(report["harnessEvidence"]).toEqual({
      passed: true,
      commandCount: 1,
      failedCommands: [],
    });
  });

  it("reports needs-attention with zero duration for a non-terminal run", async () => {
    const state = stateFixture({ status: "running", startedAt: fixedIso, finishedAt: null });
    const fixture = auditDeps(state, undefined);
    const code = await runCli(["audit", "--story-id", "S-1"], fixture.deps);
    expect(code).toBe(CLI_EXIT_BLOCKED);
    const report = parseLine(fixture.stdout.lines[0]!);
    expect(report["status"]).toBe("needs-attention");
    expect(report["durationMs"]).toBe(0);
    expect(report["harnessEvidence"]).toBeUndefined();
  });

  it("audits a fresh never-started run with empty timestamps", async () => {
    const fixture = auditDeps(stateFixture(), undefined);
    const code = await runCli(["audit", "--story-id", "S-1"], fixture.deps);
    expect(code).toBe(CLI_EXIT_BLOCKED);
    const report = parseLine(fixture.stdout.lines[0]!);
    expect(report["startedAt"]).toBe("");
    expect(report["finishedAt"]).toBe("");
    expect(report["durationMs"]).toBe(0);
  });

  it("clamps unparseable or negative durations to zero", async () => {
    const state = stateFixture({
      status: "done",
      startedAt: "not-a-date",
      finishedAt: "also-not-a-date",
    });
    const fixture = auditDeps(state, undefined);
    await runCli(["audit", "--story-id", "S-1", "--project-root", "/repo"], fixture.deps);
    const report = parseLine(fixture.stdout.lines[0]!);
    expect(report["durationMs"]).toBe(0);
  });
});

describe("runCli iso command", () => {
  it("ensures the worktree and prints its metadata as one JSON line", async () => {
    const captured: unknown[] = [];
    const fixture = depsFixture({
      ensureWorktree: (request) => {
        captured.push(request);
        return Promise.resolve(
          Object.freeze({ storyId: request.storyId, branch: "story/s-1", path: "/wt/s-1" }),
        );
      },
    });
    const code = await runCli(["iso", "--story-id", "S-1", "--spec-file", "spec.md"], fixture.deps);
    expect(code).toBe(CLI_EXIT_OK);
    expect(captured[0]).toEqual({ projectRoot: "/fixture-cwd", storyId: "S-1" });
    expect(parseLine(fixture.stdout.lines[0]!)).toEqual({
      command: "iso",
      storyId: "S-1",
      specFile: "spec.md",
      branch: "story/s-1",
      path: "/wt/s-1",
    });
  });

  it("uses the explicit project root when given", async () => {
    const captured: unknown[] = [];
    const fixture = depsFixture({
      ensureWorktree: (request) => {
        captured.push(request);
        return Promise.resolve(
          Object.freeze({ storyId: request.storyId, branch: "b", path: "/p" }),
        );
      },
    });
    await runCli(
      ["iso", "--story-id", "S-1", "--spec-file", "spec.md", "--project-root", "/repo"],
      fixture.deps,
    );
    expect(captured[0]).toEqual({ projectRoot: "/repo", storyId: "S-1" });
  });
});

describe("runCli merge command", () => {
  const passingEvaluation: MergeGateEvaluation = Object.freeze({
    decision: "merge-allowed",
    passed: true,
    blockers: Object.freeze([]),
    reason: "Merge gate passed.",
  });

  it("emits a state-not-found error event and returns 2 when state is missing", async () => {
    const fixture = depsFixture({ loadState: () => Promise.resolve(undefined) });
    const code = await runCli(["merge", "--story-id", "S-1"], fixture.deps);
    expect(code).toBe(CLI_EXIT_BLOCKED);
    const event = parseLine(fixture.stdout.lines[0]!);
    expect(event["code"]).toBe(STATE_NOT_FOUND_ERROR_CODE);
  });

  it("fails closed through the real merge gate when artifacts are missing", async () => {
    const fixture = depsFixture({
      loadState: () => Promise.resolve(stateFixture({ status: "pr-opened" })),
      loadEvidence: () => Promise.resolve(undefined),
      loadCurrentRun: () => Promise.resolve(undefined),
      evaluateMerge: evaluateMergeGate,
    });
    const code = await runCli(["merge", "--story-id", "S-1"], fixture.deps);
    expect(code).toBe(CLI_EXIT_BLOCKED);
    const event = parseLine(fixture.stdout.lines[0]!);
    expect(event["event"]).toBe("merge.decision");
    expect(event["decision"]).toBe("merge-blocked");
    const blockers = event["blockers"] as string[];
    expect(blockers.join(" ")).toContain("missing-pull-request");
    expect(blockers.join(" ")).toContain("harness-evidence-missing");
  });

  it("forwards evidence and a matching agent claim to the merge gate", async () => {
    const requests: EvaluateMergeGateRequest[] = [];
    const fixture = depsFixture({
      loadState: () => Promise.resolve(stateFixture({ status: "pr-opened" })),
      loadEvidence: () => Promise.resolve(evidenceFixture(true)),
      loadCurrentRun: () =>
        Promise.resolve(Object.freeze({ storyId: "S-1", agentClaim: { testsPassed: true } })),
      evaluateMerge: (request) => {
        requests.push(request);
        return passingEvaluation;
      },
    });
    const code = await runCli(["merge", "--story-id", "S-1"], fixture.deps);
    expect(code).toBe(CLI_EXIT_OK);
    expect(requests[0]!.harnessEvidence).toEqual(evidenceFixture(true));
    expect(requests[0]!.agentClaim).toEqual({ testsPassed: true });
    const event = parseLine(fixture.stdout.lines[0]!);
    expect(event["decision"]).toBe("merge-allowed");
    expect(event["blockers"]).toEqual([]);
  });

  it("ignores a current-run pointer for a different story", async () => {
    const requests: EvaluateMergeGateRequest[] = [];
    const fixture = depsFixture({
      loadState: () => Promise.resolve(stateFixture({ status: "pr-opened" })),
      loadEvidence: () => Promise.resolve(undefined),
      loadCurrentRun: () =>
        Promise.resolve(Object.freeze({ storyId: "OTHER", agentClaim: { testsPassed: true } })),
      evaluateMerge: (request) => {
        requests.push(request);
        return passingEvaluation;
      },
    });
    await runCli(["merge", "--story-id", "S-1"], fixture.deps);
    expect(requests[0]!.agentClaim).toBeUndefined();
    expect(requests[0]!.harnessEvidence).toBeUndefined();
  });
});

describe("defaultRunCliDeps", () => {
  it("wires the real implementations", () => {
    expect(defaultRunCliDeps.runPipeline).toBe(runPipelineAction);
    expect(defaultRunCliDeps.loadState).toBe(loadPipelineState);
    expect(defaultRunCliDeps.loadEvidence).toBe(loadHarnessEvidence);
    expect(defaultRunCliDeps.loadCurrentRun).toBe(loadCurrentRunPointer);
    expect(defaultRunCliDeps.generateAudit).toBe(generatePipelineAuditReport);
    expect(typeof defaultRunCliDeps.compileStages).toBe("function");
    expect(defaultRunCliDeps.ensureWorktree).toBe(ensureStoryWorktree);
    expect(defaultRunCliDeps.evaluateMerge).toBe(evaluateMergeGate);
    expect(defaultRunCliDeps.env).toBe(process.env);
    expect(defaultRunCliDeps.cwd()).toBe(process.cwd());
    expect(Object.isFrozen(defaultRunCliDeps)).toBe(true);
  });
});

describe("isMainModule", () => {
  const identity = (path: string): string => path;

  it("matches when the module URL equals the executed entry path", () => {
    const url = pathToFileURL("/tmp/entry.js").href;
    expect(isMainModule(url, ["node", "/tmp/entry.js"], identity)).toBe(true);
  });

  it("does not match a different entry path", () => {
    const url = pathToFileURL("/tmp/entry.js").href;
    expect(isMainModule(url, ["node", "/tmp/other.js"], identity)).toBe(false);
  });

  it("does not match when no entry path exists", () => {
    expect(isMainModule(pathToFileURL("/tmp/entry.js").href, ["node"])).toBe(false);
  });

  it("matches a bin shim entry through the injected path resolver", () => {
    const url = pathToFileURL("/real/dist/src/cli.js").href;
    const resolveShim = (path: string): string =>
      path === "/bin/bmad-pipeline" ? "/real/dist/src/cli.js" : path;
    expect(isMainModule(url, ["node", "/bin/bmad-pipeline"], resolveShim)).toBe(true);
  });

  it("realpaths an existing default entry and passes through a missing one", () => {
    const existing = realpathSync(`${process.cwd()}/package.json`);
    expect(isMainModule(pathToFileURL(existing).href, ["node", existing])).toBe(true);
    const missing = "/no/such/entry.js";
    expect(isMainModule(pathToFileURL(missing).href, ["node", missing])).toBe(true);
  });
});
