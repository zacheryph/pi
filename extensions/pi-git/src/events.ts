/**
 * events.ts — what pi-git publishes on the session's `pi.events` bus.
 */

/** pi-surface views: the `/git:worktrees` and `/git:prs` explorers, defined while a session runs. */
export const GIT_WORKTREES_VIEW = "git.worktrees";
export const GIT_PRS_VIEW = "git.prs";
/** pi-surface summary view: this session's worktree and pull request totals (see `gitSummaryModel`). */
export const GIT_SUMMARY_VIEW = "git.summary";
