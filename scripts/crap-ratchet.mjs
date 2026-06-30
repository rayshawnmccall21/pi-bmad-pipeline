/**
 * CRAP Ratchet
 *
 * Implements the D2 ratchet spec from pi-bmad/docs/program-software-factory.md.
 * Unlike crap-report.mjs (fixed threshold 30, report-only), the ratchet enforces
 * MONOTONIC improvement against a committed baseline so CRAP can only go down.
 *
 * It fails the build when:
 *   (a) any existing function rises above its baseline CRAP by more than EPSILON,
 *   (b) the count of functions above PACKAGE_TARGET increases vs baseline,
 *   (c) a NEW function lands with CRAP >= NEW_FN_LIMIT.
 *
 * Baseline updates only in a baseline-only commit via `--update-baseline`.
 * PACKAGE_TARGET ratchets 30 -> 20 -> 10 across milestones (edit below).
 * CRAP < 5 everywhere is the release gate.
 *
 * Usage:
 *   node scripts/crap-ratchet.mjs                 # enforce
 *   node scripts/crap-ratchet.mjs --update-baseline  # rewrite quality/crap-baseline.json
 *
 * Requires: vitest run --coverage (generates coverage/coverage-final.json).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const COVERAGE_PATH = join(process.cwd(), "coverage", "coverage-final.json");
const BASELINE_PATH = join(process.cwd(), "quality", "crap-baseline.json");

// Ratchet knobs. Tighten PACKAGE_TARGET at each milestone: 30 -> 20 -> 10.
const PACKAGE_TARGET = 5;
const EPSILON = 0.5;
const NEW_FN_LIMIT = 5;

const updateBaseline = process.argv.includes("--update-baseline");

if (!existsSync(COVERAGE_PATH)) {
  console.error("No coverage data found. Run: npm run test:coverage");
  process.exit(1);
}

/**
 * Computes per-function CRAP scores from v8 coverage, keyed by "file::fn".
 * @returns {Record<string, number>} map of function key to rounded CRAP score
 */
function computeScores() {
  const coverage = JSON.parse(readFileSync(COVERAGE_PATH, "utf-8"));
  const scores = {};

  for (const [filePath, fileData] of Object.entries(coverage)) {
    const relativePath = filePath.replace(process.cwd() + "/", "");
    const fnMap = fileData.fnMap || {};
    const fnCoverage = fileData.f || {};
    const branchMap = fileData.branchMap || {};
    const branchCoverage = fileData.b || {};

    for (const [fnId, fnDef] of Object.entries(fnMap)) {
      const fnName = fnDef.name || `anonymous@${fnDef.loc?.start?.line}`;
      const hits = fnCoverage[fnId] || 0;
      const fnCov = hits > 0 ? 100 : 0;
      const fnStart = fnDef.loc?.start?.line || 0;
      const fnEnd = fnDef.loc?.end?.line || 0;

      let branchCount = 0;
      let coveredBranches = 0;
      for (const [brId, brDef] of Object.entries(branchMap)) {
        const brLine = brDef.loc?.start?.line || 0;
        if (brLine >= fnStart && brLine <= fnEnd) {
          const branchHits = branchCoverage[brId] || [];
          branchCount += branchHits.length;
          coveredBranches += branchHits.filter((h) => h > 0).length;
        }
      }

      const complexity = Math.max(1, Math.floor(branchCount / 2) + 1);
      let effectiveCov = fnCov;
      if (branchCount > 0) {
        effectiveCov = (fnCov + (coveredBranches / branchCount) * 100) / 2;
      }

      const crap = Math.pow(complexity, 2) * Math.pow(1 - effectiveCov / 100, 3) + complexity;
      scores[`${relativePath}::${fnName}`] = Math.round(crap * 10) / 10;
    }
  }
  return scores;
}

const scores = computeScores();

if (updateBaseline) {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  const aboveTarget = Object.values(scores).filter((c) => c > PACKAGE_TARGET).length;
  const baseline = { target: PACKAGE_TARGET, aboveTarget, functions: scores };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
  console.log(
    `Baseline written: ${Object.keys(scores).length} functions, ${aboveTarget} above target ${PACKAGE_TARGET}.`,
  );
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error("No baseline found. Seed it with: npm run crap:update-baseline");
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
const baseFns = baseline.functions || {};
const violations = [];

for (const [key, crap] of Object.entries(scores)) {
  const prior = baseFns[key];
  if (prior === undefined) {
    if (crap >= NEW_FN_LIMIT) {
      violations.push(`NEW function ${key} lands at CRAP ${crap} (limit ${NEW_FN_LIMIT}).`);
    }
  } else if (crap > prior + EPSILON) {
    violations.push(`REGRESSION ${key}: CRAP ${crap} > baseline ${prior} + ${EPSILON}.`);
  }
}

const aboveTargetNow = Object.values(scores).filter((c) => c > PACKAGE_TARGET).length;
if (aboveTargetNow > (baseline.aboveTarget ?? 0)) {
  violations.push(
    `aboveTarget count rose: ${aboveTargetNow} > baseline ${baseline.aboveTarget ?? 0} (target ${PACKAGE_TARGET}).`,
  );
}

console.log("\nCRAP Ratchet");
console.log("-".repeat(60));
console.log(`Target: ${PACKAGE_TARGET} | epsilon: ${EPSILON} | new-fn limit: ${NEW_FN_LIMIT}`);
console.log(`Functions scored: ${Object.keys(scores).length} | above target: ${aboveTargetNow}`);

if (violations.length > 0) {
  console.log("-".repeat(60));
  for (const v of violations) {
    console.log(`  FAIL ${v}`);
  }
  console.log(
    "\nCRAP ratchet failed. Lower complexity or raise coverage; baseline updates only via a baseline-only commit (--update-baseline).",
  );
  process.exit(1);
}

console.log("CRAP ratchet passed: no regressions vs baseline.");
