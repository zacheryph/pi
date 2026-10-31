/**
 * workspace-provider.ts — git worktree implementation of the pi-subagents
 * WorkspaceProvider seam (ADR 0002, Phase 16 Step 3).
 *
 * The core consults a registered provider for every child run. This provider
 * isolates a child in a git worktree only when its agent type is opted in via
 * `worktreeAgents`; for any other agent it returns `undefined`, leaving the
 * child to run in the parent cwd. On worktree-creation failure for an opted-in
 * agent it throws, failing the run loudly rather than silently running
 * unisolated (preserving the core's former strict behavior).
 */

import type {
  Workspace,
  WorkspaceDisposeOutcome,
  WorkspacePrepareContext,
  WorkspaceProvider,
} from "@gotgenes/pi-subagents";
import type { ActiveWorktrees } from "#src/active-worktrees";
import type { WorktreesConfig } from "#src/config";
import {
  cleanupWorktree,
  createWorktree,
  type WorktreeInfo,
} from "#src/worktree";

/** A prepared git worktree plus its bracketed teardown. Born complete. */
class WorktreeWorkspace implements Workspace {
  constructor(
    private readonly repoCwd: string,
    private readonly info: WorktreeInfo,
    private readonly live: ActiveWorktrees,
  ) {}

  /** The worktree directory — already exists when this workspace is handed back. */
  get cwd(): string {
    return this.info.path;
  }

  dispose(
    outcome: WorkspaceDisposeOutcome,
  ): { resultAddendum?: string } | undefined {
    const result = cleanupWorktree(
      this.repoCwd,
      this.info,
      outcome.description,
    );
    // No child is running here any more — a worktree cleanup left behind is a
    // preserved one from this point on, and the scan may report it.
    this.live.remove(this.info.path);
    switch (result.outcome) {
      case "clean":
        return undefined;
      case "committed": {
        const bypassNote = result.hooksBypassed
          ? "\nCommit hooks were bypassed to save this work — review the commit before merging."
          : "";
        return {
          resultAddendum: `\n\n---\nChanges saved to branch \`${result.branch}\`. Merge with: \`git merge ${result.branch}\`${bypassNote}`,
        };
      }
      case "failed":
        return {
          resultAddendum: `\n\n---\nWorktree cleanup failed; the worktree was left in place at \`${result.path}\` for manual recovery: ${result.error}`,
        };
    }
  }
}

/** Registers a git worktree per opted-in agent type; runs others in the parent cwd. */
export class WorktreeWorkspaceProvider implements WorkspaceProvider {
  constructor(
    private readonly config: WorktreesConfig,
    private readonly live: ActiveWorktrees,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- the seam contract is async; worktree creation is synchronous, but staying async ensures failures reject the returned promise rather than throwing synchronously at the call site
  async prepare(ctx: WorkspacePrepareContext): Promise<Workspace | undefined> {
    if (!this.config.worktreeAgents.includes(ctx.agentType)) return undefined;

    const info = createWorktree(ctx.baseCwd, ctx.agentId);
    if (!info) {
      throw new Error(
        `Cannot run agent "${ctx.agentType}" with worktree isolation — ` +
          "not a git repo, no commits yet, or `git worktree add` failed. " +
          "Initialize git and commit at least once, or remove the agent from worktreeAgents.",
      );
    }
    this.live.add(info.path);
    return new WorktreeWorkspace(ctx.baseCwd, info, this.live);
  }
}
