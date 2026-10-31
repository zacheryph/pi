/**
 * pi-subagents-worktrees — git worktree isolation for @gotgenes/pi-subagents.
 *
 * Registers a WorkspaceProvider (ADR 0002, Phase 16 Step 3) that runs opted-in
 * subagents in a temporary git worktree. The core consults the provider for
 * every child run; this package decides which agents get a worktree (via the
 * worktreeAgents config) and brackets the run with git plumbing.
 *
 * The provider is registered on session_start with that session's own
 * SubagentsService, which the bundled pi-subagents publishes from its own
 * session_start handler — list this package after it (Pi runs handlers in load
 * order). If the service is absent, children run unisolated.
 */

import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { getSubagentsService } from "../../pi-subagents/src/service/service.ts";
import { ActiveWorktrees } from "#src/active-worktrees";
import { loadWorktreesConfig } from "#src/config";
import { debugLog } from "#src/debug";
import { findPreservedWorktrees, formatPreservedNotice } from "#src/preserved";
import { registerPreservedWorktreesCommand } from "#src/preserved-command";
import {
  findUnmergedRescueBranches,
  formatRescueBranchNotice,
} from "#src/rescue-branches";
import { WorktreeWorkspaceProvider } from "#src/workspace-provider";
import { discardWorktree, pruneWorktrees } from "#src/worktree";

export default function piSubagentsWorktrees(pi: ExtensionAPI): void {
  const config = loadWorktreesConfig(getAgentDir(), process.cwd());

  // Best-effort crash recovery: clear worktrees orphaned by a prior crash.
  pruneWorktrees(process.cwd());

  const live = new ActiveWorktrees();
  const repoCwd = process.cwd();
  const findPreserved = () => findPreservedWorktrees(repoCwd, live);
  let unregister: (() => void) | undefined;

  // Local change: the bundled pi-subagents publishes one service per session on
  // session_start, and a child session's lookup without an id returns its
  // parent's. Register with this session's own service, so each session's
  // children are isolated by its own manager.
  pi.on("session_start", (_event, ctx) => {
    unregister?.();
    unregister = undefined;
    const service = getSubagentsService(ctx.sessionManager.getSessionId());
    if (service) {
      unregister = service.registerWorkspaceProvider(
        new WorktreeWorkspaceProvider(config, live),
      );
    } else {
      debugLog(
        "subagents service unavailable — worktree provider not registered",
        undefined,
      );
    }

    // The rescue artifacts a session start reports: worktrees a failed cleanup
    // left on disk, and branches a successful one committed to that nobody
    // merged. Two notices rather than one, because they are different artifacts
    // with different remedies. A session with no UI (every subagent child) has
    // nowhere to show either, so it does not even look.
    if (!ctx.hasUI) return;
    const preserved = findPreserved();
    if (preserved.length > 0) {
      ctx.ui.notify(formatPreservedNotice(preserved), "warning");
    }
    const unmerged = findUnmergedRescueBranches(repoCwd);
    if (unmerged.length > 0) {
      ctx.ui.notify(formatRescueBranchNotice(unmerged), "warning");
    }
  });

  registerPreservedWorktreesCommand(pi, {
    findPreserved,
    discard: (path) => discardWorktree(repoCwd, path),
  });

  pi.on("session_shutdown", () => {
    unregister?.();
    unregister = undefined;
  });
}
