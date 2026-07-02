import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

/** Checkpoint result shape returned by the module gate handler. */
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
interface E2eGatesModule {
  readonly apiVersion: string;
  readonly register: (api: StubCheckpointApi) => readonly GateRegistration[];
}

const gateName = "pipeline--e2e-module-gate";
const statePath = ".pi/artifacts/e2e/module-state.json";

const moduleUrl = pathToFileURL(
  resolve(
    import.meta.dirname,
    "../../.pi/workflows/checkpoints/validate-checkpoint-extensibility-gates.mjs",
  ),
).href;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isModuleShape = (value: unknown): value is E2eGatesModule =>
  isRecord(value) &&
  typeof value["apiVersion"] === "string" &&
  typeof value["register"] === "function";

const loadModule = async (): Promise<E2eGatesModule> => {
  const imported: unknown = await import(moduleUrl);
  if (!isRecord(imported) || !isModuleShape(imported["default"])) {
    throw new TypeError(
      "validate-checkpoint-extensibility-gates.mjs must default-export a checkpoint module.",
    );
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
    throw new TypeError(`validate-checkpoint-extensibility-gates.mjs must register ${gateName}.`);
  }
  return registration;
};

const runGate = async (files: Readonly<Record<string, string>>): Promise<GateResult> => {
  const registration = await loadGate(files);
  return registration.handler();
};

interface ProbeFixture {
  readonly name: string;
  readonly status: string;
}

const probe = (name: string, status = "passed"): ProbeFixture => ({ name, status });

const greenProbes = [probe("blocked-probe"), probe("evidence-lane"), probe("command-lane")];

interface StateOverrides {
  readonly checkpoint?: unknown;
  readonly status?: unknown;
  readonly storyId?: unknown;
  readonly probes?: unknown;
  readonly totalProbes?: unknown;
  readonly passedProbes?: unknown;
  readonly allProbesPassed?: unknown;
}

const stateDoc = (overrides: StateOverrides = {}): string =>
  JSON.stringify({
    checkpoint: gateName,
    status: "passed",
    storyId: "E2E-CHECKPOINT-1",
    probes: greenProbes,
    totalProbes: 3,
    passedProbes: 3,
    allProbesPassed: true,
    ...overrides,
  });

const greenFiles = (): Record<string, string> => ({ [statePath]: stateDoc() });

describe("pipeline--e2e-module-gate checkpoint module", () => {
  it("declares the checkpoint-module v2 apiVersion", async () => {
    const checkpointModule = await loadModule();

    expect(checkpointModule.apiVersion).toBe("pi-bmad.checkpoint-module.v2");
  });

  it("registers the prefixed module gate with a bounded timeout", async () => {
    const registration = await loadGate(greenFiles());

    expect(registration.name).toBe(gateName);
    expect(registration.timeoutMs).toBeGreaterThan(0);
  });

  it("passes when every claimed count matches the recomputed probe facts", async () => {
    const result = await runGate(greenFiles());

    expect(result).toMatchObject({ pass: true });
    expect(result.reason).toContain("E2E-CHECKPOINT-1");
  });

  it("fails closed when the module state file is missing", async () => {
    const result = await runGate({});

    expect(result.pass).toBe(false);
    expect(result.reason).toContain(statePath);
  });

  it("fails closed when the module state JSON is invalid", async () => {
    const result = await runGate({ [statePath]: "{ this is not json" });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain(statePath);
  });

  it("fails closed on the generic over-claim document", async () => {
    const overClaim = JSON.stringify({ checkpoint: gateName, status: "passed" });

    const result = await runGate({ [statePath]: overClaim });

    expect(result.pass).toBe(false);
  });

  it("fails closed on the strongest over-claim: counts asserted with no probe records", async () => {
    const result = await runGate({ [statePath]: stateDoc({ probes: [] }) });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("probes");
  });

  it("fails closed when the state names a different checkpoint", async () => {
    const result = await runGate({
      [statePath]: stateDoc({ checkpoint: "pipeline--merge-gate-green" }),
    });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("checkpoint");
  });

  it("fails closed when the state status is not passed", async () => {
    const result = await runGate({ [statePath]: stateDoc({ status: "blocked" }) });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("status");
  });

  it("fails closed when the storyId is not filename-safe", async () => {
    const result = await runGate({ [statePath]: stateDoc({ storyId: "../evil" }) });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("storyId");
  });

  it("fails closed when a probe record is malformed", async () => {
    const result = await runGate({
      [statePath]: stateDoc({ probes: [probe("blocked-probe"), { name: "command-lane" }] }),
    });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("probes");
  });

  it("fails closed when totalProbes diverges from the recomputed probe count", async () => {
    const result = await runGate({ [statePath]: stateDoc({ totalProbes: 2 }) });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("totalProbes");
    expect(result.details).toMatchObject({ claimedTotalProbes: 2, recomputedTotalProbes: 3 });
  });

  it("fails closed when passedProbes diverges from the recomputed passed count", async () => {
    const result = await runGate({ [statePath]: stateDoc({ passedProbes: 2 }) });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("passedProbes");
    expect(result.details).toMatchObject({ claimedPassedProbes: 2, recomputedPassedProbes: 3 });
  });

  it("fails closed when allProbesPassed is over-claimed against a failing probe", async () => {
    const failingProbes = [
      probe("blocked-probe"),
      probe("evidence-lane"),
      probe("command-lane", "failed"),
    ];

    const result = await runGate({
      [statePath]: stateDoc({ probes: failingProbes, passedProbes: 2 }),
    });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("allProbesPassed");
    expect(result.details).toMatchObject({ failingProbes: ["command-lane"] });
  });

  it("fails closed when the run honestly reports a non-green lane", async () => {
    const failingProbes = [
      probe("blocked-probe"),
      probe("evidence-lane"),
      probe("command-lane", "failed"),
    ];

    const result = await runGate({
      [statePath]: stateDoc({ probes: failingProbes, passedProbes: 2, allProbesPassed: false }),
    });

    expect(result.pass).toBe(false);
    expect(result.details).toMatchObject({ failingProbes: ["command-lane"] });
  });
});
