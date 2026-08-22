#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const executableShebang = "#!/usr/bin/env -S uv run --script";
const uvTimeoutMs = 5_000;
const maximumChildOutputBytes = 64 * 1024;
const maximumDiagnosticBytes = 3_500;
const defaultRoot = fileURLToPath(new URL("../tools/review-gates", import.meta.url));

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

const reportDiagnostics = (diagnostics) => {
  const output = `${diagnostics.join("\n")}\n`;
  const outputBytes = Buffer.from(output);
  if (outputBytes.length <= maximumDiagnosticBytes) {
    process.stderr.write(outputBytes);
    return;
  }

  process.stderr.write(
    `${outputBytes.subarray(0, maximumDiagnosticBytes - 64).toString("utf8")}\n... diagnostics truncated\n`,
  );
};

const parseRoot = () => {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 0) return defaultRoot;
  if (arguments_.length === 2 && arguments_[0] === "--root" && arguments_[1].length > 0) {
    return resolve(arguments_[1]);
  }
  throw new Error("usage: node scripts/check-review-gate-locks.mjs [--root <directory>]");
};

const main = () => {
  let root;
  try {
    root = parseRoot();
  } catch (error) {
    reportDiagnostics([errorMessage(error)]);
    return 2;
  }

  let entries;
  try {
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    reportDiagnostics([
      `review-gate root is not a readable directory: ${root}: ${errorMessage(error)}`,
    ]);
    return 2;
  }

  const infrastructureFailures = [];
  const scriptPaths = [];
  for (const entry of entries
    .filter((candidate) => candidate.isFile() && candidate.name.endsWith(".py"))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const scriptPath = resolve(root, entry.name);
    try {
      const source = readFileSync(scriptPath, "utf8");
      const newlineIndex = source.indexOf("\n");
      const firstLine = newlineIndex === -1 ? source : source.slice(0, newlineIndex);
      if (firstLine === executableShebang) scriptPaths.push(scriptPath);
    } catch (error) {
      infrastructureFailures.push(`${entry.name}: unable to read script: ${errorMessage(error)}`);
    }
  }

  if (scriptPaths.length === 0) {
    reportDiagnostics([
      ...infrastructureFailures,
      `no executable review-gate scripts found in ${root}`,
    ]);
    return 2;
  }

  const validationFailures = [];
  for (const scriptPath of scriptPaths) {
    const scriptName = basename(scriptPath);
    const lockPath = `${scriptPath}.lock`;
    try {
      if (!statSync(lockPath).isFile()) {
        validationFailures.push(`${scriptName}: adjacent lock is not a file: ${lockPath}`);
        continue;
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        validationFailures.push(`${scriptName}: missing adjacent lock: ${lockPath}`);
      } else {
        infrastructureFailures.push(
          `${scriptName}: unable to inspect adjacent lock: ${errorMessage(error)}`,
        );
      }
      continue;
    }

    const freshnessResult = spawnSync("uv", ["lock", "--check", "--script", scriptPath], {
      encoding: "utf8",
      timeout: uvTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: maximumChildOutputBytes,
      shell: false,
    });

    if (freshnessResult.error) {
      infrastructureFailures.push(
        freshnessResult.error.code === "ETIMEDOUT"
          ? `${scriptName}: uv freshness check timed out after ${String(uvTimeoutMs)}ms`
          : `${scriptName}: uv unavailable or failed to spawn: ${errorMessage(freshnessResult.error)}`,
      );
    } else if (freshnessResult.status === null || freshnessResult.signal !== null) {
      infrastructureFailures.push(
        `${scriptName}: uv freshness check terminated unexpectedly${freshnessResult.signal ? ` (${freshnessResult.signal})` : ""}`,
      );
    } else if (freshnessResult.status !== 0) {
      const detail = (freshnessResult.stderr || freshnessResult.stdout).trim();
      validationFailures.push(
        `${scriptName}: uv lock freshness check failed (exit ${String(freshnessResult.status)})${detail ? `: ${detail}` : ""}`,
      );
    }
  }

  if (infrastructureFailures.length > 0) {
    reportDiagnostics([...validationFailures, ...infrastructureFailures]);
    return 2;
  }
  if (validationFailures.length > 0) {
    reportDiagnostics(validationFailures);
    return 1;
  }
  return 0;
};

try {
  process.exitCode = main();
} catch (error) {
  reportDiagnostics([`unexpected validator infrastructure failure: ${errorMessage(error)}`]);
  process.exitCode = 2;
}
