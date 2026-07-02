import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

/** Checkpoint result shape returned by the merge gate handler. */
interface GateResult {
  readonly pass: boolean;
  readonly reason: string;
  readonly details?: unknown;
}

/** Gate handler exercised with injected readers only. */
type GateHandler = () => Promise<GateResult>;

/** One registration returned by the module's register(api). */
interface GateRegistration {
  readonly name: string;
  readonly timeoutMs?: number;
  readonly handler: GateHandler;
}

/** Injected read-only checkpoint api seam (subset of ProjectCheckpointApiV2). */
interface StubCheckpointApi {
  readonly readJson: (path: string) => unknown;
  readonly fileExists: (path: string) => boolean;
}

/** Default-export shape of a checkpoint-module v2 file. */
interface MergeGateModule {
  readonly apiVersion: string;
  readonly register: (api: StubCheckpointApi) => readonly GateRegistration[];
}

const gateName = "pipeline--merge-gate-green";
const pointerPath = ".pi/pipeline/state/current-run.json";
const statePath = ".pi/pipeline/state/STORY-123.json";
const evidencePath = ".pi/pipeline/evidence/STORY-123/harness-evidence.json";

const moduleUrl = pathToFileURL(
  resolve(import.meta.dirname, "../../.pi/workflows/checkpoints/merge-gate.mjs"),
).href;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isModuleShape = (value: unknown): value is MergeGateModule =>
  isRecord(value) &&
  typeof value["apiVersion"] === "string" &&
  typeof value["register"] === "function";

const loadModule = async (): Promise<MergeGateModule> => {
  const imported: unknown = await import(moduleUrl);
  if (!isRecord(imported) || !isModuleShape(imported["default"])) {
    throw new TypeError("merge-gate.mjs must default-export a checkpoint module.");
  }
  return imported["default"];
};

const createStubApi = (files: Readonly<Record<string, string>>): StubCheckpointApi => ({
  readJson: (path: string): unknown => {
    const raw = files[path];
    if (raw === undefined) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed;
    } catch {
      return null;
    }
  },
  fileExists: (path: string): boolean => files[path] !== undefined,
});

const loadGate = async (files: Readonly<Record<string, string>>): Promise<GateRegistration> => {
  const checkpointModule = await loadModule();
  const registration = checkpointModule
    .register(createStubApi(files))
    .find((candidate) => candidate.name === gateName);
  if (registration === undefined) {
    throw new TypeError(`merge-gate.mjs must register ${gateName}.`);
  }
  return registration;
};

const runGate = async (files: Readonly<Record<string, string>>): Promise<GateResult> => {
  const registration = await loadGate(files);
  return registration.handler();
};

interface AgentClaimFixture {
  readonly testsPassed?: boolean;
  readonly typecheckPassed?: boolean;
  readonly lintPassed?: boolean;
}

const pointerDoc = (agentClaim?: AgentClaimFixture): string =>
  JSON.stringify({
    storyId: "STORY-123",
    ...(agentClaim === undefined ? {} : { agentClaim }),
  });

const stateDoc = (storyId = "STORY-123"): string =>
  JSON.stringify({ storyId, status: "running", currentStage: "merge" });

interface CommandFixture {
  readonly name: string;
  readonly status: string;
}

const command = (name: string, status = "passed"): CommandFixture => ({ name, status });

const evidenceDoc = (passed: boolean, commands: readonly CommandFixture[]): string =>
  JSON.stringify({
    projectRoot: "/repo",
    startedAt: "2026-07-02T00:00:00.000Z",
    finishedAt: "2026-07-02T00:01:00.000Z",
    passed,
    commands,
  });

const allPassedCommands = [command("test"), command("typecheck"), command("lint")];

const greenFiles = (): Record<string, string> => ({
  [pointerPath]: pointerDoc({ testsPassed: true, typecheckPassed: true, lintPassed: true }),
  [statePath]: stateDoc(),
  [evidencePath]: evidenceDoc(true, allPassedCommands),
});

describe("pipeline--merge-gate-green checkpoint module", () => {
  it("declares the checkpoint-module v2 apiVersion", async () => {
    const checkpointModule = await loadModule();

    expect(checkpointModule.apiVersion).toBe("pi-bmad.checkpoint-module.v2");
  });

  it("registers the prefixed merge gate with a bounded timeout", async () => {
    const registration = await loadGate(greenFiles());

    expect(registration.name).toBe(gateName);
    expect(registration.timeoutMs).toBeGreaterThan(0);
  });

  it("passes when state, harness evidence, and agent claims agree", async () => {
    const result = await runGate(greenFiles());

    expect(result).toMatchObject({ pass: true });
    expect(result.reason).toContain("STORY-123");
  });

  it("fails closed when the pipeline state pointer is missing", async () => {
    const result = await runGate({});

    expect(result.pass).toBe(false);
    expect(result.reason).toContain(pointerPath);
  });

  it("fails closed when the pointer has no filename-safe storyId", async () => {
    const files = { [pointerPath]: JSON.stringify({ storyId: "../evil" }) };

    const result = await runGate(files);

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("storyId");
  });

  it("fails closed when durable pipeline state is missing", async () => {
    const files = { [pointerPath]: pointerDoc() };

    const result = await runGate(files);

    expect(result.pass).toBe(false);
    expect(result.reason).toContain(statePath);
  });

  it("fails closed when durable state storyId does not match the pointer", async () => {
    const files = {
      [pointerPath]: pointerDoc(),
      [statePath]: stateDoc("OTHER-9"),
      [evidencePath]: evidenceDoc(true, allPassedCommands),
    };

    const result = await runGate(files);

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("storyId");
  });

  it("fails closed when the harness evidence file is missing", async () => {
    const files = { [pointerPath]: pointerDoc(), [statePath]: stateDoc() };

    const result = await runGate(files);

    expect(result.pass).toBe(false);
    expect(result.reason).toContain(evidencePath);
  });

  it("fails closed when the harness evidence JSON is invalid", async () => {
    const files = {
      [pointerPath]: pointerDoc(),
      [statePath]: stateDoc(),
      [evidencePath]: "{ this is not json",
    };

    const result = await runGate(files);

    expect(result.pass).toBe(false);
    expect(result.reason).toContain(evidencePath);
  });

  it("fails closed on the generic over-claim document at every path", async () => {
    const overClaim = JSON.stringify({ checkpoint: gateName, status: "passed" });
    const files = {
      [pointerPath]: overClaim,
      [statePath]: overClaim,
      [evidencePath]: overClaim,
    };

    const result = await runGate(files);

    expect(result.pass).toBe(false);
  });

  it("fails closed when success-claiming evidence carries no command results", async () => {
    const files = {
      [pointerPath]: pointerDoc(),
      [statePath]: stateDoc(),
      [evidencePath]: evidenceDoc(true, []),
    };

    const result = await runGate(files);

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("command results");
  });

  it("fails closed when harness evidence failed and names failing commands", async () => {
    const files = {
      [pointerPath]: pointerDoc(),
      [statePath]: stateDoc(),
      [evidencePath]: evidenceDoc(false, [command("test", "failed"), command("lint")]),
    };

    const result = await runGate(files);

    expect(result.pass).toBe(false);
    expect(result.details).toMatchObject({ failingCommands: ["test"] });
  });

  it("fails closed when evidence claims success but a command did not pass", async () => {
    const files = {
      [pointerPath]: pointerDoc(),
      [statePath]: stateDoc(),
      [evidencePath]: evidenceDoc(true, [command("test"), command("lint", "failed")]),
    };

    const result = await runGate(files);

    expect(result.pass).toBe(false);
    expect(result.details).toMatchObject({ failingCommands: ["lint"] });
  });

  it("fails closed when agent claims diverge from harness evidence", async () => {
    const files = {
      [pointerPath]: pointerDoc({ testsPassed: true, lintPassed: true }),
      [statePath]: stateDoc(),
      [evidencePath]: evidenceDoc(true, [command("test"), command("typecheck")]),
    };

    const result = await runGate(files);

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("diverged");
    expect(result.details).toMatchObject({ diverged: ["lintPassed"] });
  });

  it("ignores absent agent claims like the in-process merge gate", async () => {
    const files = {
      [pointerPath]: pointerDoc(),
      [statePath]: stateDoc(),
      [evidencePath]: evidenceDoc(true, allPassedCommands),
    };

    const result = await runGate(files);

    expect(result.pass).toBe(true);
  });
});
