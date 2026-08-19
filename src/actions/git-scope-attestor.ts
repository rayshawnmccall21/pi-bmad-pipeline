/* eslint-disable jsdoc/require-description, jsdoc/no-blank-blocks, jsdoc/require-param, jsdoc/require-returns, jsdoc/require-example, @typescript-eslint/no-magic-numbers -- Git porcelain parsing and fixed-argv observation are kept together at the trust boundary. */
import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  compareFinalScopeToReview,
  createFinalScopeReceipt,
  createReviewScopeCheckpoint,
} from "../security/index.js";

import type {
  ScopeAttestationRequest,
  ScopeAttestationResult,
  ScopeAttestor,
} from "../core/scope-attestation.js";

/** Injected boundaries for trusted Git scope observation. */
interface GitScopeAttestorDependencies {
  /**
   *
   */
  readonly runGit: (projectRoot: string, args: readonly string[]) => Promise<string>;
  /**
   *
   */
  readonly readBytes: (projectRoot: string, path: string) => Promise<Uint8Array>;
}

/** Builds the real fixed-argv Git scope attestor used by the action composition root. */
export function createGitScopeAttestor(
  overrides: Partial<GitScopeAttestorDependencies> = {},
): ScopeAttestor {
  const dependencies: GitScopeAttestorDependencies = {
    runGit: overrides.runGit ?? runGit,
    readBytes: overrides.readBytes ?? readRepositoryBytes,
  };
  return async (request) => attestObservedScope(dependencies, request);
}

interface ObservedGitScope {
  readonly branch: string;
  readonly baseOid: string;
  readonly files: readonly { readonly path: string; readonly bytes: Uint8Array }[];
}

const observeGitScope = async (
  dependencies: GitScopeAttestorDependencies,
  request: ScopeAttestationRequest,
): Promise<ObservedGitScope> => {
  const branch = (
    await dependencies.runGit(request.projectRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  ).trim();
  const baseOid = (await dependencies.runGit(request.projectRoot, ["rev-parse", "main"])).trim();
  const committedPaths = await observeCommittedPaths(dependencies, request.projectRoot, baseOid);
  const dirtyPaths = parseChangedPaths(
    await dependencies.runGit(request.projectRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]),
  );
  const paths = [...new Set([...committedPaths, ...dirtyPaths])].sort();
  const files = await Promise.all(
    paths.map(async (path) => ({
      path,
      bytes: await dependencies.readBytes(request.projectRoot, path),
    })),
  );
  return { branch, baseOid, files };
};

const checkpointForObservedScope = (request: ScopeAttestationRequest, observed: ObservedGitScope) =>
  createReviewScopeCheckpoint({
    storyId: request.storyId,
    runId: request.runId,
    runDefId: request.runDefId,
    runDefDigest: request.runDefDigest,
    branch: observed.branch,
    baseOid: observed.baseOid,
    reviewedFiles: observed.files.filter(({ path }) => !isDocumentationPath(path)),
    qualityGate: request.qualityGate,
  });

const finalScopeResult = (
  request: Extract<ScopeAttestationRequest, { phase: "final" }>,
  observed: ObservedGitScope,
): ScopeAttestationResult => {
  const checkpoint = request.reviewCheckpoint ?? checkpointForObservedScope(request, observed);
  if (checkpoint.branch !== observed.branch || checkpoint.baseOid !== observed.baseOid) {
    return { kind: "rejected", reason: "Git branch or base OID changed after review." };
  }
  const comparison = compareFinalScopeToReview({
    checkpoint,
    finalFiles: observed.files,
    allowedDocsPaths: observed.files
      .filter(({ path }) => isDocumentationPath(path))
      .map(({ path }) => path),
  });
  return comparison.kind === "review-invalidated"
    ? comparison
    : {
        kind: "final-receipt",
        receipt: createFinalScopeReceipt({ checkpoint, comparison }),
      };
};

const attestObservedScope = async (
  dependencies: GitScopeAttestorDependencies,
  request: ScopeAttestationRequest,
): Promise<ScopeAttestationResult> => {
  try {
    const observed = await observeGitScope(dependencies, request);
    return request.phase === "review"
      ? { kind: "review-checkpoint", checkpoint: checkpointForObservedScope(request, observed) }
      : finalScopeResult(request, observed);
  } catch (error) {
    return {
      kind: "rejected",
      reason: error instanceof Error ? error.message : "Git scope attestation failed.",
    };
  }
};

const observeCommittedPaths = async (
  dependencies: GitScopeAttestorDependencies,
  projectRoot: string,
  baseOid: string,
): Promise<string[]> => {
  const headOid = (await dependencies.runGit(projectRoot, ["rev-parse", "HEAD"])).trim();
  if (headOid === baseOid) {
    return [];
  }
  return parseCommittedPaths(
    await dependencies.runGit(projectRoot, ["diff", "--name-only", "-z", baseOid, headOid, "--"]),
  );
};

const parseChangedPaths = (porcelain: string): string[] => {
  const paths: string[] = [];
  for (const entry of porcelain.split("\0").filter((value) => value.length > 0)) {
    if (entry.length < 4 || entry[2] !== " ") {
      throw new TypeError("Malformed Git porcelain scope entry.");
    }
    const status = entry.slice(0, 2);
    if (/[DRC]/u.test(status)) {
      throw new TypeError(
        "Deleted, renamed, or copied paths cannot be attested by this receipt version.",
      );
    }
    const path = entry.slice(3);
    if (!path.startsWith(".pi/pipeline/")) {
      paths.push(path);
    }
  }
  return paths;
};

const parseCommittedPaths = (output: string): string[] => {
  if (output.length > 0 && !output.endsWith("\0")) {
    throw new TypeError("Malformed Git committed scope output.");
  }
  return output.split("\0").filter((path) => path.length > 0 && !path.startsWith(".pi/pipeline/"));
};

const documentationFileNames = new Set([
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE.md",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
]);
const nonDocumentationSegments = new Set([
  ".github",
  ".pi",
  "agent",
  "agents",
  "command",
  "commands",
  "config",
  "configuration",
  "instruction",
  "instructions",
  "prompt",
  "prompts",
  "skill",
  "skills",
  "spec",
  "specification",
  "specifications",
  "specs",
  "workflow",
  "workflows",
]);
const executableInstructionNames = new Set([
  "agents.md",
  "claude.md",
  "command.md",
  "config.md",
  "configuration.md",
  "context.md",
  "gemini.md",
  "instruction.md",
  "instructions.md",
  "prompt.md",
  "skill.md",
  "spec.md",
  "specification.md",
  "workflow.md",
]);

const isExecutableDocumentation = (
  lowerSegments: readonly string[],
  lowerFileName: string,
): boolean =>
  [
    executableInstructionNames.has(lowerFileName),
    lowerSegments.some((segment) => nonDocumentationSegments.has(segment)),
    lowerSegments.slice(0, -1).some((segment) => segment.startsWith(".")),
    /(?:^|[._-])(?:agents?|commands?|config(?:uration)?|contexts?|instructions?|prompts?|skills?|spec(?:ification)?s?|workflows?)\.md$/u.test(
      lowerFileName,
    ),
  ].some(Boolean);

const isAllowedDocumentationLocation = (segments: readonly string[], fileName: string): boolean =>
  [documentationFileNames.has(fileName), segments[0] === "docs" && fileName.endsWith(".md")].some(
    Boolean,
  );

const isDocumentationPath = (path: string): boolean => {
  const segments = path.split("/");
  const fileName = segments.at(-1) ?? "";
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  return (
    !isExecutableDocumentation(lowerSegments, fileName.toLowerCase()) &&
    isAllowedDocumentationLocation(segments, fileName)
  );
};

const readRepositoryBytes = async (projectRoot: string, path: string): Promise<Uint8Array> => {
  const physicalRoot = await realpath(projectRoot);
  const candidate = resolve(physicalRoot, path);
  const relativePath = relative(physicalRoot, candidate);
  if (relativePath.startsWith("..") || resolve(physicalRoot, relativePath) !== candidate) {
    throw new TypeError("Git scope path escapes the project root.");
  }
  if ((await lstat(candidate)).isSymbolicLink()) {
    throw new TypeError("Git scope path targets a symlink.");
  }
  const physicalPath = await realpath(candidate);
  const physicalRelative = relative(physicalRoot, physicalPath);
  if (
    physicalRelative.startsWith("..") ||
    resolve(physicalRoot, physicalRelative) !== physicalPath
  ) {
    throw new TypeError("Git scope file escapes the project root.");
  }
  return new Uint8Array(await readFile(physicalPath));
};

const runGit = (projectRoot: string, args: readonly string[]): Promise<string> =>
  new Promise((resolveOutput, rejectOutput) => {
    const child = spawn("git", [...args], {
      cwd: projectRoot,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", rejectOutput);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectOutput(
          new Error(
            `git ${args[0] ?? "command"} failed: ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
        return;
      }
      resolveOutput(Buffer.concat(stdout).toString("utf8"));
    });
  });
