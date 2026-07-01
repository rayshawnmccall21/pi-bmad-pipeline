/** Public Git subsystem exports. */
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
  EnsureStoryWorktreeRequest,
  GitCommandResult,
  GitSpawn,
  GitWorktreeErrorCode,
  GitWorktreeErrorDetails,
  RemoveStoryWorktreeRequest,
  RunGitCommandRequest,
  StoryWorktree,
} from "./worktrees.js";
