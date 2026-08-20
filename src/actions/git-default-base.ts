/** Authenticates the synchronized main-or-master base used for scope receipts. */

const OBJECT_ID = /^[0-9a-f]{40}$/u;
const DEFAULT_REMOTE_REF = /^refs\/remotes\/origin\/(main|master)$/u;
const stripTrailingNewline = (value: string): string =>
  value.endsWith("\n") ? value.slice(0, -1) : value;

/** Fixed-argv Git observation boundary. */
type ScopeGitRunner = (projectRoot: string, args: readonly string[]) => Promise<string>;

interface DefaultBaseIdentity {
  readonly remoteHead: string;
  readonly localRef: string;
  readonly remoteRef: string;
  readonly oid: string;
}

const readIdentity = async (
  runGit: ScopeGitRunner,
  projectRoot: string,
): Promise<DefaultBaseIdentity> => {
  const remoteHead = stripTrailingNewline(
    await runGit(projectRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]),
  );
  const branch = DEFAULT_REMOTE_REF.exec(remoteHead)?.[1];
  if (branch === undefined) {
    throw new Error("Authenticated origin HEAD must name main or master.");
  }
  const localRef = `refs/heads/${branch}`;
  const remoteRef = `refs/remotes/origin/${branch}`;
  const [localOid, remoteOid] = await Promise.all([
    runGit(projectRoot, ["rev-parse", "--verify", localRef]),
    runGit(projectRoot, ["rev-parse", "--verify", remoteRef]),
  ]);
  const oid = stripTrailingNewline(localOid);
  if (!OBJECT_ID.test(oid) || stripTrailingNewline(remoteOid) !== oid) {
    throw new Error("Local and remote default refs are not synchronized.");
  }
  return { remoteHead, localRef, remoteRef, oid };
};

const requireStableIdentity = async (
  runGit: ScopeGitRunner,
  projectRoot: string,
  expected: DefaultBaseIdentity,
): Promise<void> => {
  const [remoteHead, localOid, remoteOid] = await Promise.all([
    runGit(projectRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]),
    runGit(projectRoot, ["rev-parse", "--verify", expected.localRef]),
    runGit(projectRoot, ["rev-parse", "--verify", expected.remoteRef]),
  ]);
  if (
    stripTrailingNewline(remoteHead) !== expected.remoteHead ||
    stripTrailingNewline(localOid) !== expected.oid ||
    stripTrailingNewline(remoteOid) !== expected.oid
  ) {
    throw new Error("Default branch identity moved during scope authentication.");
  }
};

/**
 * Resolves a stable synchronized local/remote default-branch OID.
 *
 * @param runGit - Fixed-argv Git observation boundary.
 * @param projectRoot - Exact repository root.
 *
 * @returns Authenticated base OID for main or master.
 *
 * @example
 * ```ts
 * const baseOid = await observeSynchronizedDefaultBaseOid(runGit, projectRoot);
 * ```
 */
export async function observeSynchronizedDefaultBaseOid(
  runGit: ScopeGitRunner,
  projectRoot: string,
): Promise<string> {
  const identity = await readIdentity(runGit, projectRoot);
  await requireStableIdentity(runGit, projectRoot, identity);
  return identity.oid;
}
