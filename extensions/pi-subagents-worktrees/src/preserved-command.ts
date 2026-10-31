/**
 * preserved-command.ts — `/subagents-worktrees`, the on-demand view of the
 * rescue worktrees a failed cleanup left behind.
 *
 * The startup notice reports them once; this command lists them at any time and
 * removes one the user is finished with. Removal always goes through an
 * explicit confirmation — the whole reason these worktrees survive is that
 * nothing should delete them without a human deciding.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The selector entry that leaves everything alone. */
const CLOSE = "Close";

export interface PreservedCommandDeps {
  /** Rescue worktrees currently on disk, in the order to offer them. */
  findPreserved: () => string[];
  /** Remove one, throwing with a reportable reason when git refuses. */
  discard: (path: string) => void;
}

/** Register `/subagents-worktrees`. */
export function registerPreservedWorktreesCommand(
  pi: ExtensionAPI,
  deps: PreservedCommandDeps,
): void {
  pi.registerCommand("subagents-worktrees", {
    description:
      "List rescue worktrees preserved by a failed cleanup, and remove one you no longer need",
    handler: async (_args, ctx) => {
      const preserved = deps.findPreserved();
      if (preserved.length === 0) {
        ctx.ui.notify("No preserved rescue worktrees found.", "info");
        return;
      }

      const choice = await ctx.ui.select("Preserved rescue worktrees", [
        ...preserved,
        CLOSE,
      ]);
      if (choice === undefined || choice === CLOSE) return;

      const confirmed = await ctx.ui.confirm(
        "Remove this worktree?",
        `Delete ${choice} and everything in it. This cannot be undone — merge or copy anything you still need first.`,
      );
      if (!confirmed) return;

      try {
        deps.discard(choice);
        ctx.ui.notify(`Removed ${choice}.`, "info");
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Could not remove ${choice}: ${reason}`, "error");
      }
    },
  });
}
