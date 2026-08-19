#!/usr/bin/env node
// Integration-test stub for the hermetic BMAD stage child.
//
// Emits one provenance-stamped tool_execution_end envelope for the requested
// workflow, mirroring the pi-bmad headless terminal contract exactly:
//   - envelope identity is HMAC-SHA256 under PI_BMAD_EMISSION_KEY
//   - envelope fields must pass pi-bmad structural and payload-schema gating
//     (the schema root is resolved from the real extension path by the
//     supervisor)
//   - accepted terminal output must match the requested workflow
//
// Behavior knobs (test-only, read from the child environment):
//   E2E_GARBAGE=1         emit a non-JSON line instead of an envelope
//   E2E_SILENT=1          emit nothing
//   E2E_NO_ENVELOPE=1     emit a non-terminal event only
//   E2E_FORGE=1           omit the emissionProvenance block entirely
//   E2E_BAD_MARKER=1      stamp a forged engineMarker
//   E2E_BAD_SIG=1         stamp a non-hex signature
//   E2E_WRONG_KEY=1       sign under a different emission key
//   E2E_WRONG_WORKFLOW=1  emit a signed envelope for a different workflow
//   E2E_CONTRADICT=1      e2e-verify payload: verdict pass + failed scenarios
//   E2E_WRONG_STORY=1     envelope payload storyId differs from the active story
//   E2E_USAGE=1           emit a message_end assistant usage record
//   E2E_CREDENTIAL=<tok>  plant a token in e2e-verify failed scenario ids
//   E2E_SLEEP_MS=<n>      sleep before emitting (timeout tests)
//   E2E_EXIT=<n>          process exit code after emission
//   E2E_STDERR=<text>     write text to stderr before exit
//   E2E_STDERR_CHARS=<n>  write n stderr chars before exit
//   E2E_MARKER=<path>     write a marker file on spawn (no-spawn assertions)
//   E2E_STAGE_TRACE=<path> append workflow, attempt, and durable state per spawn
//   e2e-verify stages fail on attempt 1 and pass on attempt 2 so the
//   regression/onFail routing can be exercised end to end.
//
// The pure builders below are exported so the e2e suite can reference this
// file as a module; the terminal emission only runs when this file is the
// process entry point.
import { createHmac } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ENGINE_MARKER = "pi-bmad.workflow-engine.terminal-emission.v2";

/**
 * Builds the terminal envelope for the requested workflow.
 *
 * @param options - Workflow, active story id, attempt, and optional gate-fail
 *   every attempt switch.
 *
 * @returns The unstamped envelope (no emissionProvenance block).
 */
export function buildTerminalEnvelope({ workflow, storyId, attempt, failAlways = false }) {
  const envelope = {
    schemaVersion: "pi-bmad.headless-workflow-result.v1",
    workflow,
    returnType: `pi-bmad.workflow.${workflow}.result.v1`,
    status: "success",
    exitCode: 0,
    completedSteps: ["terminal"],
    failedSteps: [],
    artifacts: { summary: `.pi/artifacts/${workflow}/summary.md` },
    payload: null,
    emittedAt: new Date().toISOString(),
    durationMs: 1,
  };

  if (workflow === "dev-story") {
    envelope.payload = {
      storyId,
      testsAdded: 1,
      filesChanged: ["src/index.ts"],
      testsPassed: true,
      typecheckPassed: true,
      lintPassed: true,
    };
  } else if (workflow === "code-review") {
    envelope.payload = {
      storyId,
      verdict: "approved",
      findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      autoFixed: false,
    };
  } else if (workflow === "docs") {
    envelope.payload = {
      rootIndexUpdated: false,
      claudeSymlinkOk: true,
      moduleContextCounts: { created: 0, updated: 0, migrated: 0, removed: 0 },
      driftFixed: 0,
    };
  } else if (workflow === "e2e-verify") {
    const failed = failAlways || attempt === 1;
    envelope.payload = {
      storyId,
      scenariosPassed: failed ? 0 : 2,
      scenariosFailed: failed ? 1 : 0,
      failedScenarioIds: failed ? ["AC-1"] : [],
      partialScenarioIds: [],
      verdict: failed ? "fail" : "pass",
    };
  } else {
    throw new Error(`unsupported workflow ${workflow}`);
  }

  return envelope;
}

// Mirrors pi-bmad canonicalEnvelopeIdentity + signEmissionProvenance so the
// supervisor's provenance gate accepts the envelope under the emitted key.
const canonicalize = (value) => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const ordered = {};
    for (const key of Object.keys(value).sort()) {
      ordered[key] = canonicalize(value[key]);
    }
    return ordered;
  }
  return value ?? null;
};

const canonicalIdentity = (candidate) =>
  JSON.stringify([
    typeof candidate.schemaVersion === "string" ? candidate.schemaVersion : null,
    typeof candidate.workflow === "string" ? candidate.workflow : null,
    typeof candidate.returnType === "string" ? candidate.returnType : null,
    typeof candidate.status === "string" ? candidate.status : null,
    candidate.exitCode ?? null,
    Array.isArray(candidate.completedSteps)
      ? candidate.completedSteps.filter((step) => typeof step === "string")
      : [],
    canonicalize(candidate.failedSteps ?? []),
    canonicalize(candidate.artifacts ?? {}),
    canonicalize(candidate.payload ?? null),
    typeof candidate.emittedAt === "string" ? candidate.emittedAt : null,
    candidate.durationMs ?? null,
  ]);

const stampProvenance = (envelope, emissionKey) => ({
  engineMarker: ENGINE_MARKER,
  signature: createHmac("sha256", emissionKey).update(canonicalIdentity(envelope)).digest("hex"),
});

const isMainModule =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const argValue = (name) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };

  const knobs = {
    garbage: process.env.E2E_GARBAGE !== undefined,
    silent: process.env.E2E_SILENT !== undefined,
    noEnvelope: process.env.E2E_NO_ENVELOPE !== undefined,
    forge: process.env.E2E_FORGE !== undefined,
    badMarker: process.env.E2E_BAD_MARKER !== undefined,
    badSig: process.env.E2E_BAD_SIG !== undefined,
    wrongKey: process.env.E2E_WRONG_KEY !== undefined,
    wrongWorkflow: process.env.E2E_WRONG_WORKFLOW !== undefined,
    contradict: process.env.E2E_CONTRADICT !== undefined,
    wrongStory: process.env.E2E_WRONG_STORY !== undefined,
    usage: process.env.E2E_USAGE !== undefined,
    failAlways: process.env.E2E_FAIL_ALWAYS !== undefined,
    credential: process.env.E2E_CREDENTIAL,
    sleepMs: Number(process.env.E2E_SLEEP_MS ?? "0"),
    exitCode: Number(process.env.E2E_EXIT ?? "0"),
    stderr: process.env.E2E_STDERR ?? "",
    stderrChars: Number(process.env.E2E_STDERR_CHARS ?? "0"),
    marker: process.env.E2E_MARKER,
    stageTrace: process.env.E2E_STAGE_TRACE,
  };

  const workflow = argValue("--bmad-workflow") ?? "dev-story";
  const storyId = argValue("--bmad-story") ?? "E2E-STORY";
  const attempt = Number((process.env.PI_BMAD_RUN_ID ?? ".1").split(".").at(-1) ?? "1");
  const emissionKey = process.env.PI_BMAD_EMISSION_KEY ?? "";

  if (knobs.marker !== undefined) {
    writeFileSync(knobs.marker, "spawned\n", "utf8");
  }
  if (knobs.stageTrace !== undefined) {
    const stateFile = resolve(".pi", "pipeline", "state", `${storyId}.json`);
    appendFileSync(
      knobs.stageTrace,
      `${JSON.stringify({
        workflow,
        attempt,
        state: JSON.parse(readFileSync(stateFile, "utf8")),
      })}\n`,
      "utf8",
    );
  }
  if (knobs.stderrChars > 0) {
    process.stderr.write("x".repeat(knobs.stderrChars));
  } else if (knobs.stderr.length > 0) {
    process.stderr.write(knobs.stderr);
  }

  const finish = (code = knobs.exitCode) => process.exit(code);

  if (knobs.garbage) {
    process.stdout.write("this is not json\n");
    finish();
  }
  if (knobs.sleepMs > 0) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, knobs.sleepMs));
  }
  if (knobs.silent) {
    finish();
  }

  const envelope = buildTerminalEnvelope({
    workflow,
    storyId,
    attempt,
    failAlways: knobs.failAlways,
  });

  if (knobs.contradict && workflow === "e2e-verify") {
    envelope.payload = {
      storyId,
      scenariosPassed: 1,
      scenariosFailed: 1,
      failedScenarioIds: ["AC-1"],
      partialScenarioIds: [],
      verdict: "pass",
    };
  }
  if (knobs.wrongStory) {
    envelope.payload.storyId = "OTHER-STORY";
  }
  if (knobs.credential !== undefined && envelope.payload.verdict === "fail") {
    envelope.payload.failedScenarioIds = [knobs.credential];
  }
  if (knobs.wrongWorkflow) {
    envelope.workflow = "custom-e2e-workflow";
    envelope.returnType = "pi-bmad.workflow.custom-e2e-workflow.result.v1";
  }

  if (knobs.usage) {
    process.stdout.write(
      `${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", usage: { totalTokens: 5, cost: { total: 0.01 } } },
      })}\n`,
    );
  }
  if (knobs.noEnvelope) {
    process.stdout.write(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "done" } })}\n`,
    );
    finish(0);
  }

  if (!knobs.forge) {
    const signingKey = knobs.wrongKey ? "a".repeat(64) : emissionKey;
    envelope.emissionProvenance = stampProvenance(envelope, signingKey);
    if (knobs.badMarker) {
      envelope.emissionProvenance.engineMarker = "forged.marker";
    }
    if (knobs.badSig) {
      envelope.emissionProvenance.signature = "zz";
    }
  }

  process.stdout.write(
    `${JSON.stringify({ type: "tool_execution_end", result: { details: { headlessOutput: envelope } } })}\n`,
  );
  finish();
}
