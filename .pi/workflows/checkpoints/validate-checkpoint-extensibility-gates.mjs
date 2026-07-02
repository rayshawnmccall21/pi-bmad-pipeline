// @ts-check
// Rung-3 project checkpoint module (checkpoint-module v2) for the
// validate-checkpoint-extensibility workflow (Lane B of the e2e stack).
//
// Registers `pipeline--e2e-module-gate`: a read-only, fail-closed gate over
// the module-probe step's state JSON. The gate never trusts the agent's
// summary claims — it RECOMPUTES every cross-field fact from the probe
// records and fails closed on any divergence:
//   totalProbes  must equal probes.length
//   passedProbes must equal the recomputed count of status === "passed"
//   allProbesPassed must equal the recomputed conjunction, and must be true
//
// Static entry point (v1 static-path rule):
//   .pi/artifacts/e2e/module-state.json — written by the module-probe step.
//
// NO runtime import of "pi-bmad/checkpoints" here: the subpath resolves to
// TypeScript source, which plain Node refuses to load from node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Typing is JSDoc-only.

/** Registered gate name (must stay `<repo-or-workflow>--<gate>` prefixed). */
const GATE_NAME = "pipeline--e2e-module-gate";

/** Static path of the module-probe state artifact. */
const MODULE_STATE_PATH = ".pi/artifacts/e2e/module-state.json";

/** Filename-safe story id pattern; mirrors PIPELINE_STATE_STORY_ID_PATTERN. */
const STORY_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

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
const fail = (reason, details) => ({
  pass: false,
  reason,
  ...(details === undefined ? {} : { details }),
});

/**
 * Reads the probe records when they have a verifiable shape.
 *
 * @param {Record<string, unknown>} state - Parsed module-probe state.
 * @returns {readonly Record<string, unknown>[] | undefined} Probes, or undefined when malformed.
 */
const readProbes = (state) => {
  const probes = state["probes"];
  if (!Array.isArray(probes)) {
    return undefined;
  }
  const wellFormed = probes.every(
    (candidate) =>
      isRecord(candidate) &&
      typeof candidate["name"] === "string" &&
      candidate["name"].length > 0 &&
      typeof candidate["status"] === "string",
  );
  return wellFormed ? probes : undefined;
};

/**
 * Verifies the base fields (checkpoint name, status, storyId), fail-closed.
 *
 * @param {Record<string, unknown>} state - Parsed module-probe state.
 * @returns {{ pass: false, reason: string, details?: Record<string, unknown> } | undefined} Failure, or undefined when the base fields verify.
 */
const checkBaseFields = (state) => {
  if (state["checkpoint"] !== GATE_NAME) {
    return fail(`module state names the wrong checkpoint (expected ${GATE_NAME})`, {
      checkpoint: state["checkpoint"],
    });
  }
  if (state["status"] !== "passed") {
    return fail('module state status is not "passed"', { status: state["status"] });
  }
  const storyId = state["storyId"];
  if (typeof storyId !== "string" || !STORY_ID_PATTERN.test(storyId)) {
    return fail("module state has no filename-safe storyId", { storyId });
  }
  return undefined;
};

/**
 * Recomputes the cross-field probe facts and rejects any claim divergence.
 *
 * @param {Record<string, unknown>} state - Parsed module-probe state.
 * @param {readonly Record<string, unknown>[]} probes - Well-formed probe records.
 * @param {string} storyId - Verified story id, for the passing reason.
 * @returns {{ pass: boolean, reason: string, details?: Record<string, unknown> }} Result.
 */
const checkProbeConsistency = (state, probes, storyId) => {
  const recomputedTotal = probes.length;
  const failingProbes = probes
    .filter((candidate) => candidate["status"] !== "passed")
    .map((candidate) => candidate["name"]);
  const recomputedPassed = recomputedTotal - failingProbes.length;
  if (state["totalProbes"] !== recomputedTotal) {
    return fail("totalProbes claim diverged from the recomputed probe count", {
      claimedTotalProbes: state["totalProbes"],
      recomputedTotalProbes: recomputedTotal,
    });
  }
  if (state["passedProbes"] !== recomputedPassed) {
    return fail("passedProbes claim diverged from the recomputed passed count", {
      claimedPassedProbes: state["passedProbes"],
      recomputedPassedProbes: recomputedPassed,
    });
  }
  const recomputedAllPassed = recomputedTotal > 0 && failingProbes.length === 0;
  if (state["allProbesPassed"] !== recomputedAllPassed || !recomputedAllPassed) {
    return fail("allProbesPassed must be true and match the recomputed probe statuses", {
      claimedAllProbesPassed: state["allProbesPassed"],
      recomputedAllProbesPassed: recomputedAllPassed,
      failingProbes,
    });
  }
  return {
    pass: true,
    reason: `module gate recomputed ${recomputedTotal} passed probes for story ${storyId}`,
  };
};

/**
 * Evaluates the module-probe state through the injected read seam.
 *
 * @param {{ readJson: (path: string) => unknown }} api - Project-root-scoped checkpoint api.
 * @returns {{ pass: boolean, reason: string, details?: Record<string, unknown> }} Result.
 */
const evaluateModuleGate = (api) => {
  const state = api.readJson(MODULE_STATE_PATH);
  if (!isRecord(state)) {
    return fail(`module state missing or unreadable at ${MODULE_STATE_PATH}`, {
      path: MODULE_STATE_PATH,
    });
  }
  const baseFailure = checkBaseFields(state);
  if (baseFailure !== undefined) {
    return baseFailure;
  }
  const probes = readProbes(state);
  if (probes === undefined || probes.length === 0) {
    return fail("module state probes are not a non-empty array of named status records", {
      path: MODULE_STATE_PATH,
    });
  }
  return checkProbeConsistency(state, probes, /** @type {string} */ (state["storyId"]));
};

/** @type {import("pi-bmad/checkpoints").ProjectCheckpointModuleV2} */
const checkpointModule = {
  apiVersion: "pi-bmad.checkpoint-module.v2",
  register(api) {
    return [
      {
        name: GATE_NAME,
        timeoutMs: 30_000,
        handler: () => Promise.resolve(evaluateModuleGate(api)),
      },
    ];
  },
};

export default checkpointModule;
