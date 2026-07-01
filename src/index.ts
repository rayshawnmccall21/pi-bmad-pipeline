/**
 * Public barrel for the pi-bmad-pipeline package.
 *
 * This package is the standalone BMAD pipeline supervisor CLI. It owns durable
 * cross-process SDLC pipeline execution: RunDef loading/compilation, stage
 * spawning, JSONL parsing, payload gates, routing/regression, worktrees,
 * budgets/timeouts, harness-owned evidence, PR/merge logic, and audit.
 *
 * @packageDocumentation
 */

export { PACKAGE_NAME, PACKAGE_VERSION } from "./meta.js";
export * from "./contracts/index.js";
export * from "./core/index.js";
export * from "./executors/index.js";
export * from "./gates/index.js";
export * from "./git/index.js";
export * from "./model/index.js";
export * from "./rundef/index.js";
export * from "./security/index.js";
export * from "./state/index.js";
