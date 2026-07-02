// @ts-check
// Rung-3 project checkpoint module (checkpoint-module v2) for pi-bmad-pipeline.
//
// Registers `pipeline--merge-gate-green`: a read-only, fail-closed gate over
// the pipeline's durable on-disk contracts. It REIMPLEMENTS the precondition
// checks of src/git/merge-gate.ts (harness evidence present, all passed, agent
// claims not diverged) against the same artifacts — it must not import
// pipeline TypeScript, because the checkpoint kernel loads this file on plain
// Node where TS sources cannot be imported.
//
// Static entry point: the pipeline owns durable state at fixed paths.
//   .pi/pipeline/state/current-run.json                 — current-run pointer { storyId, agentClaim? }
//   .pi/pipeline/state/<storyId>.json                   — durable PipelineState (src/state/fs-state-store.ts)
//   .pi/pipeline/evidence/<storyId>/harness-evidence.json — HarnessEvidenceReport (src/security/harness-evidence-store.ts)
//
// NO runtime import of "pi-bmad/checkpoints" here: the subpath resolves to
// TypeScript source, which plain Node refuses to load from node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Typing is JSDoc-only.

/** Registered gate name (must stay `<repo-or-workflow>--<gate>` prefixed). */
const GATE_NAME = "pipeline--merge-gate-green";

/** Static pointer the pipeline maintains for the run under merge review. */
const CURRENT_RUN_POINTER_PATH = ".pi/pipeline/state/current-run.json";

/** Filename-safe story id pattern; mirrors PIPELINE_STATE_STORY_ID_PATTERN. */
const STORY_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

/** Claim-to-command mapping; mirrors claimMappings in src/git/merge-gate.ts. */
const CLAIM_MAPPINGS = Object.freeze([
  Object.freeze({ field: "testsPassed", commandName: "test" }),
  Object.freeze({ field: "typecheckPassed", commandName: "typecheck" }),
  Object.freeze({ field: "lintPassed", commandName: "lint" }),
]);

/**
 * Emits gate debug diagnostics when PI_BMAD_PIPELINE_DEBUG=1.
 *
 * @param {string} message - Debug message.
 * @param {unknown} [details] - Optional structured details.
 * @returns {void}
 */
const debugLog = (message, details) => {
  if (process.env.PI_BMAD_PIPELINE_DEBUG === "1") {
    console.error(`[${GATE_NAME}] ${message}`, details ?? "");
  }
};

/**
 * Checks for a plain (non-array) object.
 *
 * @param {unknown} value - Candidate value.
 * @returns {value is Record<string, unknown>} True for plain objects.
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Builds a fail-closed checkpoint result with diagnostics.
 *
 * @param {string} reason - Human-readable diagnostic reason.
 * @param {Record<string, unknown>} [details] - Structured diagnostic details.
 * @returns {{ pass: false, reason: string, details?: Record<string, unknown> }} Failing result.
 */
const fail = (reason, details) => {
  debugLog(`fail: ${reason}`, details);
  return { pass: false, reason, ...(details === undefined ? {} : { details }) };
};

/**
 * Reads the harness command results when they have a verifiable shape.
 *
 * @param {Record<string, unknown>} evidence - Parsed harness evidence report.
 * @returns {readonly Record<string, unknown>[] | undefined} Commands, or undefined when malformed.
 */
const readCommands = (evidence) => {
  const commands = evidence["commands"];
  if (!Array.isArray(commands)) {
    return undefined;
  }
  const wellFormed = commands.every(
    (candidate) =>
      isRecord(candidate) &&
      typeof candidate["name"] === "string" &&
      typeof candidate["status"] === "string",
  );
  return wellFormed ? commands : undefined;
};

/**
 * Names every harness command whose status is not "passed".
 *
 * @param {readonly Record<string, unknown>[]} commands - Harness command results.
 * @returns {readonly unknown[]} Failing command names.
 */
const failingNames = (commands) =>
  commands.filter((command) => command["status"] !== "passed").map((command) => command["name"]);

/**
 * Finds agent claims that diverge from harness-owned evidence. Mirrors the
 * divergence semantics of src/git/merge-gate.ts: a claim of `true` diverges
 * unless the mapped harness command exists with status "passed"; absent
 * claims are never checked.
 *
 * @param {unknown} agentClaim - Agent-reported claim object, when present.
 * @param {readonly Record<string, unknown>[]} commands - Harness command results.
 * @returns {readonly string[]} Diverged claim field names.
 */
const divergedClaims = (agentClaim, commands) => {
  if (!isRecord(agentClaim)) {
    return [];
  }
  return CLAIM_MAPPINGS.filter(
    (mapping) =>
      agentClaim[mapping.field] === true &&
      !commands.some(
        (command) => command["name"] === mapping.commandName && command["status"] === "passed",
      ),
  ).map((mapping) => mapping.field);
};

/**
 * Verifies the harness evidence report for one story, fail-closed.
 *
 * @param {Record<string, unknown>} evidence - Parsed harness evidence report.
 * @param {unknown} agentClaim - Agent-reported claim object, when present.
 * @param {string} storyId - Story id under merge review.
 * @returns {{ pass: boolean, reason: string, details?: Record<string, unknown> }} Result.
 */
const checkEvidence = (evidence, agentClaim, storyId) => {
  const commands = readCommands(evidence);
  if (commands === undefined) {
    return fail("harness evidence commands are not a command-result array", { storyId });
  }
  if (evidence["passed"] !== true) {
    return fail("harness-owned evidence failed", {
      storyId,
      failingCommands: failingNames(commands),
    });
  }
  if (commands.length === 0) {
    return fail(
      "harness evidence carries no command results, so the success claim has no verifiable proof",
      {
        storyId,
      },
    );
  }
  const failing = failingNames(commands);
  if (failing.length > 0) {
    return fail("harness evidence claims success but contains non-passed commands", {
      storyId,
      failingCommands: failing,
    });
  }
  const diverged = divergedClaims(agentClaim, commands);
  if (diverged.length > 0) {
    return fail("agent evidence claim diverged from harness-owned evidence", {
      storyId,
      diverged,
    });
  }
  debugLog(`pass: merge gate preconditions green for story ${storyId}`);
  return { pass: true, reason: `merge gate preconditions green for story ${storyId}` };
};

/**
 * Evaluates the merge-gate preconditions through the injected read seam.
 *
 * @param {{ readJson: (path: string) => unknown }} api - Project-root-scoped checkpoint api.
 * @returns {{ pass: boolean, reason: string, details?: Record<string, unknown> }} Result.
 */
const evaluateMergeGate = (api) => {
  const pointer = api.readJson(CURRENT_RUN_POINTER_PATH);
  if (!isRecord(pointer)) {
    return fail(`pipeline state pointer missing or unreadable at ${CURRENT_RUN_POINTER_PATH}`, {
      path: CURRENT_RUN_POINTER_PATH,
    });
  }
  const storyId = pointer["storyId"];
  if (typeof storyId !== "string" || !STORY_ID_PATTERN.test(storyId)) {
    return fail("pipeline state pointer has no filename-safe storyId", { storyId });
  }
  const statePath = `.pi/pipeline/state/${storyId}.json`;
  const state = api.readJson(statePath);
  if (!isRecord(state)) {
    return fail(`durable pipeline state missing or unreadable at ${statePath}`, {
      path: statePath,
      storyId,
    });
  }
  if (state["storyId"] !== storyId) {
    return fail("durable pipeline state storyId does not match the current-run pointer", {
      path: statePath,
      storyId,
      stateStoryId: state["storyId"],
    });
  }
  const evidencePath = `.pi/pipeline/evidence/${storyId}/harness-evidence.json`;
  const evidence = api.readJson(evidencePath);
  if (!isRecord(evidence)) {
    return fail(`harness-owned evidence missing or unreadable at ${evidencePath}`, {
      path: evidencePath,
      storyId,
    });
  }
  return checkEvidence(evidence, pointer["agentClaim"], storyId);
};

/** @type {import("pi-bmad/checkpoints").ProjectCheckpointModuleV2} */
const checkpointModule = {
  apiVersion: "pi-bmad.checkpoint-module.v2",
  register(api) {
    return [
      {
        name: GATE_NAME,
        timeoutMs: 30_000,
        handler: () => Promise.resolve(evaluateMergeGate(api)),
      },
    ];
  },
};

export default checkpointModule;
