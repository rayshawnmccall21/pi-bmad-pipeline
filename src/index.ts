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
