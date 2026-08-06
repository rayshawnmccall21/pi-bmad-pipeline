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
 * @param path - Expected story worktree path.
 * @param branchRef - Expected full branch ref.
 *
 * @returns "reusable" when path and branch match one registration; "conflict"
 * when either is pinned elsewhere; "absent" when neither is registered.
 *
 * @example
 * ```ts
 * classifyWorktreeRegistration(entries, "/repo/.pi/pipeline/worktrees/s1", "refs/heads/bmad/s1");
 * ```
 */
export function classifyWorktreeRegistration(
  entries: readonly WorktreeRegistration[],
  path: string,
  branchRef: string,
): WorktreeRegistrationState {
  const atPath = entries.find((entry) => entry.path === path);
  const onBranch = entries.find((entry) => entry.branchRef === branchRef);
  if (atPath?.branchRef === branchRef) {
    return "reusable";
  }
  if (atPath !== undefined || onBranch !== undefined) {
    return "conflict";
  }
  return "absent";
}
