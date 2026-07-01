/** Public Git subsystem exports. */
export { hasBlockingGitSecretFindings, scanGitDiffForSecrets } from "./secret-scan.js";

export {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  MAX_GIT_STDERR_CHARS,
  PIPELINE_WORKTREE_RELATIVE_DIR,
  GitWorktreeError,
  ensureStoryWorktree,
  getPipelineWorktreesDir,
  getStoryBranchName,
  getStoryWorktreePath,
  removeStoryWorktree,
  runGitCommand,
} from "./worktrees.js";

export type {
  GitSecretPatternName,
  GitSecretScanFinding,
  GitSecretScanResult,
  GitSecretScanSeverity,
} from "./secret-scan.js";

export type {
  EnsureStoryWorktreeRequest,
  GitCommandResult,
  GitSpawn,
  GitWorktreeErrorCode,
  GitWorktreeErrorDetails,
  RemoveStoryWorktreeRequest,
  RunGitCommandRequest,
  StoryWorktree,
} from "./worktrees.js";
