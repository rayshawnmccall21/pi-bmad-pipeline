/**
 * CRAP Score Report Generator
 *
 * Reads vitest coverage JSON output and calculates CRAP scores per function.
 * CRAP(m) = comp(m)² × (1 - cov(m)/100)³ + comp(m)
 *
 * Since v8 coverage doesn't provide cyclomatic complexity directly,
 * we estimate it from branch coverage data (branches / 2 + 1).
 *
 * Usage: node scripts/crap-report.mjs
 * Requires: vitest run --coverage (generates coverage/coverage-final.json)
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const COVERAGE_PATH = join(process.cwd(), "coverage", "coverage-final.json");
const CRAP_THRESHOLD = 5;

if (!existsSync(COVERAGE_PATH)) {
  console.error("No coverage data found. Run: npm run test:coverage");
  process.exit(1);
}

const coverage = JSON.parse(readFileSync(COVERAGE_PATH, "utf-8"));

const results = [];

for (const [filePath, fileData] of Object.entries(coverage)) {
  const relativePath = filePath.replace(process.cwd() + "/", "");

  // Estimate per-function complexity from branch data
  const fnMap = fileData.fnMap || {};
  const fnCoverage = fileData.f || {};
  const branchMap = fileData.branchMap || {};
  const branchCoverage = fileData.b || {};

  for (const [fnId, fnDef] of Object.entries(fnMap)) {
    const fnName = fnDef.name || `anonymous@${fnDef.loc?.start?.line}`;
    const hits = fnCoverage[fnId] || 0;
    const fnCov = hits > 0 ? 100 : 0;

    // Estimate complexity: count branches within this function's line range
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

    // Cyclomatic complexity estimate: branches/2 + 1 (each branch point adds 2 paths)
    const complexity = Math.max(1, Math.floor(branchCount / 2) + 1);

    // Per-function coverage: combine function hits + branch coverage
    let effectiveCov = fnCov;
    if (branchCount > 0) {
      const branchCovPct = (coveredBranches / branchCount) * 100;
      effectiveCov = (fnCov + branchCovPct) / 2;
    }

    // CRAP formula
    const crap = Math.pow(complexity, 2) * Math.pow(1 - effectiveCov / 100, 3) + complexity;

    results.push({
      file: relativePath,
      fn: fnName,
      complexity,
      coverage: Math.round(effectiveCov),
      crap: Math.round(crap * 10) / 10,
    });
  }
}

// Sort by CRAP score descending
results.sort((a, b) => b.crap - a.crap);

// Report
console.log("\nCRAP Score Report");
console.log("=".repeat(90));
console.log(
  `${"File".padEnd(35)} ${"Function".padEnd(20)} ${"Comp".padStart(4)} ${"Cov%".padStart(5)} ${"CRAP".padStart(6)}  Status`,
);
console.log("-".repeat(90));

let failures = 0;

for (const r of results) {
  const status = r.crap > CRAP_THRESHOLD ? "REFACTOR" : r.crap <= 5 ? "clean" : "ok";
  if (r.crap > CRAP_THRESHOLD) failures++;

  console.log(
    `${r.file.padEnd(35)} ${r.fn.padEnd(20)} ${String(r.complexity).padStart(4)} ${String(r.coverage + "%").padStart(5)} ${String(r.crap).padStart(6)}  ${status}`,
  );
}

console.log("-".repeat(90));
console.log(
  `Total functions: ${results.length} | Above threshold (>${CRAP_THRESHOLD}): ${failures}`,
);
console.log(`Threshold: CRAP <= ${CRAP_THRESHOLD}\n`);

if (failures > 0) {
  console.log("CRAP check failed. Reduce complexity or increase test coverage.");
  process.exit(1);
}

console.log("All functions pass CRAP threshold.");
