#!/usr/bin/env node
// validate-receipts.mjs — plain-Node validator for create-loop receipts.
// No pi-bmad import; runs under `node` alone.
//
// Usage: node validate-receipts.mjs [receiptsPath]
// Env:  MAX_ITERATIONS (default 2) — iteration cap the receipts must respect.
//
// Asserts every receipts.jsonl line parses as JSON with the required keys
// {iteration, timestamp, action, outcome, exitCode} and that the highest
// iteration value does not exceed MAX_ITERATIONS. Exits non-zero on violation.
import fs from "node:fs";

const receiptsPath = process.argv[2] || ".pi/artifacts/create-loop/receipts.jsonl";
const maxIterations = parseInt(process.env.MAX_ITERATIONS || "2", 10);
const requiredKeys = ["iteration", "timestamp", "action", "outcome", "exitCode"];

if (!fs.existsSync(receiptsPath)) {
  console.error(`validate-receipts: receipts file not found: ${receiptsPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(receiptsPath, "utf8");
const lines = raw.split("\n").filter((line) => line.trim().length > 0);

if (lines.length === 0) {
  console.error("validate-receipts: receipts file is empty");
  process.exit(1);
}

let highestIteration = 0;

lines.forEach((line, index) => {
  const lineNumber = index + 1;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (parseError) {
    console.error(
      `validate-receipts: line ${lineNumber} is not valid JSON — ${parseError.message}`,
    );
    process.exit(1);
  }

  for (const key of requiredKeys) {
    if (!(key in parsed)) {
      console.error(`validate-receipts: line ${lineNumber} missing required key "${key}"`);
      process.exit(1);
    }
  }

  if (!Number.isInteger(parsed.iteration)) {
    console.error(
      `validate-receipts: line ${lineNumber} "iteration" must be an integer, got ${JSON.stringify(parsed.iteration)}`,
    );
    process.exit(1);
  }

  if (parsed.iteration < 1) {
    console.error(
      `validate-receipts: line ${lineNumber} "iteration" must be >= 1, got ${parsed.iteration}`,
    );
    process.exit(1);
  }

  if (parsed.iteration > highestIteration) {
    highestIteration = parsed.iteration;
  }
});

if (highestIteration > maxIterations) {
  console.error(
    `validate-receipts: highest iteration ${highestIteration} exceeds MAX_ITERATIONS ${maxIterations}`,
  );
  process.exit(1);
}

console.log(
  `validate-receipts: OK — ${lines.length} line(s), highest iteration ${highestIteration} <= MAX_ITERATIONS ${maxIterations}`,
);
process.exit(0);
