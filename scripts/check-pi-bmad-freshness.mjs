#!/usr/bin/env node
/**
 * Local pi-bmad freshness guard.
 *
 * Fails when the sibling checkout at ../pi-bmad is behind its origin/main, so
 * the pipeline gate cannot pass against a stale dependency. Skipped under CI
 * (CI floats the sibling to main at checkout time) and when the sibling is not
 * a git checkout or the network is unavailable.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const SIBLING_ROOT = resolve(process.cwd(), "..", "pi-bmad");
const GIT_DIR = join(SIBLING_ROOT, ".git");
const FETCH_TIMEOUT_MS = 15_000;

const skip = (reason) => {
  console.warn(`check-pi-bmad-freshness: skipping (${reason}).`);
  process.exit(0);
};

if (process.env.GITHUB_ACTIONS === "true") {
  skip("running under CI; sibling is floated to main");
}
if (!existsSync(GIT_DIR) && !existsSync(join(SIBLING_ROOT, ".git"))) {
  skip("no sibling git checkout at ../pi-bmad");
}

const git = (args) =>
  spawnSync("git", args, {
    cwd: SIBLING_ROOT,
    encoding: "utf8",
    timeout: FETCH_TIMEOUT_MS,
  });

if (git(["rev-parse", "--is-inside-work-tree"]).status !== 0) {
  skip("sibling is not a git work tree");
}

const fetch = git(["fetch", "origin", "main", "--quiet"]);
if (fetch.status !== 0) {
  skip("network unavailable for git fetch");
}

const local = git(["rev-parse", "HEAD"]);
const remote = git(["rev-parse", "FETCH_HEAD"]);
if (local.status !== 0 || remote.status !== 0) {
  skip("sibling refs could not be resolved");
}

const aheadOfRemote = git([
  "rev-list",
  "--count",
  `${remote.stdout.trim()}..${local.stdout.trim()}`,
]);
const behindRemote = git([
  "rev-list",
  "--count",
  `${local.stdout.trim()}..${remote.stdout.trim()}`,
]);
if (behindRemote.status !== 0 || aheadOfRemote.status !== 0) {
  skip("sibling ancestry could not be compared");
}

const behind = Number(behindRemote.stdout.trim() || "0");
if (behind > 0) {
  console.error(
    `pi-bmad sibling is ${String(behind)} commit(s) behind origin/main. ` +
      `Run: git -C ${SIBLING_ROOT} pull origin main`,
  );
  process.exit(1);
}

console.log("check-pi-bmad-freshness: pi-bmad sibling is up to date with origin/main.");
process.exit(0);
