/**
 * Pure parsing and classification of `git worktree list --porcelain` output.
 *
 * @packageDocumentation
 */

/** One registration parsed from `git worktree list --porcelain`. */
export interface WorktreeRegistration {
  /** Absolute worktree path. */
  readonly path: string;

  /** Full branch ref such as `refs/heads/bmad/story-1`; null when detached. */
  readonly branchRef: string | null;
}

/** Registration state for one story worktree path/branch pair. */
export type WorktreeRegistrationState = "reusable" | "conflict" | "absent";

/** Expected canonical identity for one story worktree registration. */
export interface ExpectedWorktreeRegistration {
  /** Expected worktree path. */
  readonly path: string;

  /** Expected full branch ref. */
  readonly branchRef: string;

  /** Optional filesystem path canonicalizer. */
  readonly canonicalizePath?: (path: string) => string;
}

/**
 * Parses `git worktree list --porcelain` stdout into registrations.
 *
 * @param stdout - Raw porcelain output.
 *
 * @returns Parsed registrations in listing order.
 *
 * @example
 * ```ts
 * parseWorktreePorcelain("worktree /repo\nbranch refs/heads/master\n");
 * ```
 */
export function parseWorktreePorcelain(stdout: string): readonly WorktreeRegistration[] {
  const entries: WorktreeRegistration[] = [];
  let current: { path?: string; branchRef?: string } = {};
  const flush = (): void => {
    if (current.path !== undefined) {
      entries.push({ path: current.path, branchRef: current.branchRef ?? null });
    }
    current = {};
  };
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ")) {
      current.branchRef = line.slice("branch ".length);
    }
  }
  flush();
  return entries;
}

/**
 * Classifies whether a story worktree can be reused, conflicts, or is absent.
 *
 * @param entries - Parsed worktree registrations.
 * @param expected - Expected path, branch, and optional canonicalizer.
 *
 * @returns "reusable" when path and branch match one registration; "conflict"
 * when either is pinned elsewhere; "absent" when neither is registered.
 *
 * @example
 * ```ts
 * classifyWorktreeRegistration(entries, {
 *   path: "/repo/.pi/pipeline/worktrees/s1",
 *   branchRef: "refs/heads/bmad/s1",
 * });
 * ```
 */
export function classifyWorktreeRegistration(
  entries: readonly WorktreeRegistration[],
  expected: ExpectedWorktreeRegistration,
): WorktreeRegistrationState {
  const canonicalizePath = expected.canonicalizePath ?? ((candidatePath: string) => candidatePath);
  const atPath = registrationAtPath(entries, expected.path, canonicalizePath);
  const onBranch = entries.find((entry) => entry.branchRef === expected.branchRef);
  return registrationState(atPath, onBranch, expected.branchRef);
}

const registrationAtPath = (
  entries: readonly WorktreeRegistration[],
  path: string,
  canonicalizePath: (path: string) => string,
): WorktreeRegistration | undefined => {
  const canonicalPath = canonicalizePath(path);
  return entries.find((entry) => canonicalizePath(entry.path) === canonicalPath);
};

const registrationState = (
  atPath: WorktreeRegistration | undefined,
  onBranch: WorktreeRegistration | undefined,
  branchRef: string,
): WorktreeRegistrationState => {
  if (atPath?.branchRef === branchRef) {
    return "reusable";
  }
  return atPath === undefined && onBranch === undefined ? "absent" : "conflict";
};
