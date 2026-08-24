/* eslint-disable jsdoc/require-description, jsdoc/no-blank-blocks, jsdoc/require-param, jsdoc/require-returns, jsdoc/require-example, @typescript-eslint/no-magic-numbers, max-lines -- Git porcelain parsing and fixed-argv observation are kept together at the trust boundary. */
import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  compareFinalScopeToReview,
  createFinalScopeReceipt,
  createReviewScopeCheckpoint,
  redactText,
  type RepositoryFileSnapshot,
} from "../security/index.js";
import { observeSynchronizedDefaultBaseOid } from "./git-default-base.js";

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
  readonly files: readonly RepositoryFileSnapshot[];
}

type GitPathAction = "present" | "absent";

interface GitPathObservation {
  readonly path: string;
  readonly action: GitPathAction;
}

interface CommittedScope {
  readonly headOid: string;
  readonly paths: readonly GitPathObservation[];
}

const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=all"] as const;

const compareGitPaths = (left: GitPathObservation, right: GitPathObservation): number =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

const mergePathObservations = (
  committed: readonly GitPathObservation[],
  dirty: readonly GitPathObservation[],
): GitPathObservation[] => {
  const paths = new Map(committed.map(({ path, action }) => [path, action]));
  for (const { path, action } of dirty) {
    paths.set(path, action);
  }
  return [...paths].map(([path, action]) => ({ path, action })).sort(compareGitPaths);
};

const isAbsentObservation = ({ action }: GitPathObservation): boolean => action === "absent";

interface AbsenceConfirmation {
  readonly observations: readonly GitPathObservation[];
  readonly headOid: string;
  readonly porcelain: string;
}

const confirmStableAbsence = async (
  dependencies: GitScopeAttestorDependencies,
  projectRoot: string,
  confirmation: AbsenceConfirmation,
): Promise<void> => {
  if (!confirmation.observations.some(isAbsentObservation)) {
    return;
  }
  const [confirmedHeadOid, confirmedPorcelain] = await Promise.all([
    readHeadOid(dependencies, projectRoot),
    dependencies.runGit(projectRoot, STATUS_ARGS),
  ]);
  if (confirmedHeadOid !== confirmation.headOid || confirmedPorcelain !== confirmation.porcelain) {
    throw new TypeError("Git scope changed while confirming an absent path.");
  }
};

const observeGitScope = async (
  dependencies: GitScopeAttestorDependencies,
  request: ScopeAttestationRequest,
): Promise<ObservedGitScope> => {
  const branch = (
    await dependencies.runGit(request.projectRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  ).trim();
  const baseOid = await observeSynchronizedDefaultBaseOid(dependencies.runGit, request.projectRoot);
  const committed = await observeCommittedScope(dependencies, request.projectRoot, baseOid);
  const porcelain = await dependencies.runGit(request.projectRoot, STATUS_ARGS);
  const observations = mergePathObservations(committed.paths, parseChangedPaths(porcelain));
  const files = await Promise.all(
    observations.map((observation) =>
      observeRepositoryFile(dependencies, request.projectRoot, observation),
    ),
  );
  await confirmStableAbsence(dependencies, request.projectRoot, {
    observations,
    headOid: committed.headOid,
    porcelain,
  });
  return { branch, baseOid, files };
};

const observeAbsentRepositoryFile = async (
  dependencies: GitScopeAttestorDependencies,
  projectRoot: string,
  path: string,
): Promise<RepositoryFileSnapshot> => {
  try {
    await dependencies.readBytes(projectRoot, path);
  } catch (error) {
    if (isCodedEnoent(error)) {
      return { path, absent: true };
    }
    throw error;
  }
  throw new TypeError("Git scope path reappeared while confirming its deletion.");
};

const observeRepositoryFile = async (
  dependencies: GitScopeAttestorDependencies,
  projectRoot: string,
  observation: GitPathObservation,
): Promise<RepositoryFileSnapshot> =>
  observation.action === "present"
    ? {
        path: observation.path,
        bytes: await dependencies.readBytes(projectRoot, observation.path),
      }
    : observeAbsentRepositoryFile(dependencies, projectRoot, observation.path);

const isCodedEnoent = (error: unknown): boolean =>
  typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";

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
      reason:
        error instanceof Error
          ? redactText(error.message).value.slice(0, 1024)
          : "Git scope attestation failed.",
    };
  }
};

const COMMITTED_DIFF_ARGS = ["diff", "--name-status", "-z", "--no-renames"] as const;

const observeCommittedScope = async (
  dependencies: GitScopeAttestorDependencies,
  projectRoot: string,
  baseOid: string,
): Promise<CommittedScope> => {
  const headOid = await readHeadOid(dependencies, projectRoot);
  if (headOid === baseOid) {
    return { headOid, paths: [] };
  }
  const mergeBase = parseMergeBase(
    await dependencies.runGit(projectRoot, ["merge-base", "--all", baseOid, headOid]),
  );
  return {
    headOid,
    paths: parseCommittedPaths(
      await dependencies.runGit(projectRoot, [...COMMITTED_DIFF_ARGS, mergeBase, headOid, "--"]),
    ),
  };
};

const readHeadOid = async (
  dependencies: GitScopeAttestorDependencies,
  projectRoot: string,
): Promise<string> => parseObjectId(await dependencies.runGit(projectRoot, ["rev-parse", "HEAD"]));

const parseObjectId = (output: string): string => {
  if (!/^[0-9a-f]{40}\n?$/u.test(output)) {
    throw new TypeError("Git scope requires a lowercase 40-character HEAD OID.");
  }
  return output.replace(/\n$/u, "");
};

const parseMergeBase = (output: string): string => {
  if (!/^[0-9a-f]{40}\n?$/u.test(output)) {
    throw new TypeError("Git scope requires exactly one merge base.");
  }
  return output.replace(/\n$/u, "");
};

const CHANGED_PATH_ACTIONS = new Map<string, GitPathAction>([
  [" M", "present"],
  ["M ", "present"],
  ["MM", "present"],
  ["??", "present"],
  ["D ", "absent"],
  [" D", "absent"],
]);

const assertUniqueGitPath = (observedPaths: Set<string>, path: string, source: string): void => {
  if (observedPaths.has(path)) {
    throw new TypeError(`Duplicate Git ${source} scope path.`);
  }
  observedPaths.add(path);
};

const appendAttestedObservation = (
  paths: GitPathObservation[],
  path: string,
  action: GitPathAction,
): void => {
  if (!path.startsWith(".pi/pipeline/")) {
    paths.push({ path, action });
  }
};

const parseChangedPaths = (porcelain: string): GitPathObservation[] => {
  const entries = porcelain.split("\0");
  const terminalRecord = entries.pop();
  if ([terminalRecord !== "", entries.some((entry) => entry.length === 0)].some(Boolean)) {
    throw new TypeError("Malformed Git porcelain scope output.");
  }
  const paths: GitPathObservation[] = [];
  const observedPaths = new Set<string>();
  for (const entry of entries) {
    if (entry.length < 4 || entry[2] !== " ") {
      throw new TypeError("Malformed Git porcelain scope entry.");
    }
    const action = CHANGED_PATH_ACTIONS.get(entry.slice(0, 2));
    if (action === undefined) {
      throw new TypeError("Unsupported Git porcelain scope status.");
    }
    const path = entry.slice(3);
    assertUniqueGitPath(observedPaths, path, "porcelain");
    appendAttestedObservation(paths, path, action);
  }
  return paths;
};

const areSupportedCommittedFields = (fields: readonly string[]): boolean =>
  fields.length % 2 === 0 &&
  fields.every((field, index) => field !== "" && (index % 2 === 1 || /^[AMD]$/u.test(field)));

const committedPathAction = (status: string): GitPathAction =>
  status === "D" ? "absent" : "present";

const parseCommittedPaths = (output: string): GitPathObservation[] => {
  const fields = output.split("\0");
  if (fields.pop() !== "" || !areSupportedCommittedFields(fields)) {
    throw new TypeError("Unsupported or malformed Git committed scope output.");
  }
  const paths: GitPathObservation[] = [];
  const observedPaths = new Set<string>();
  for (let index = 0; index < fields.length; index += 2) {
    const path = fields[index + 1] ?? "";
    assertUniqueGitPath(observedPaths, path, "committed");
    appendAttestedObservation(paths, path, committedPathAction(fields[index] ?? ""));
  }
  return paths;
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
    /(?:^|[._-])(?:agents?|commands?|config(?:uration)?|contexts?|instructions?|prompts?|skills?|spec(?:ification)?s?|workflows?)(?:[._-].*)?\.md$/u.test(
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
