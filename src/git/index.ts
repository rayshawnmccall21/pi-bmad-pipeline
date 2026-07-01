/** Public Git subsystem exports. */
export { evaluateMergeGate } from "./merge-gate.js";
export { hasBlockingGitSecretFindings, scanGitDiffForSecrets } from "./secret-scan.js";

export {
  DEFAULT_STORY_PR_TITLE_PREFIX,
  MAX_GH_STDERR_CHARS,
  StoryPullRequestError,
  buildStoryPullRequestBody,
  buildStoryPullRequestTitle,
  openStoryPullRequest,
  parsePullRequestNumber,
} from "./story-pull-request.js";

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
  AgentEvidenceClaim,
  EvaluateMergeGateRequest,
  MergeGateBlocker,
  MergeGateBlockerCode,
  MergeGateDecisionKind,
  MergeGateEvaluation,
  MergeGatePullRequest,
} from "./merge-gate.js";

export type {
  OpenStoryPullRequestRequest,
  StoryPullRequest,
  StoryPullRequestErrorCode,
  StoryPullRequestErrorDetails,
  StoryPullRequestSpawn,
} from "./story-pull-request.js";

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
