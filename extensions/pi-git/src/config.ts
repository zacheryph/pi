/**
 * config.ts — `~/.pi/agent/git.json`, overridden by the project's `.pi/git.json`.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  bool,
  defineSettings,
  string,
  type SettingsOf,
} from "../../../packages/pi-foundations/src/settings.ts";

/** Expand `~/` and resolve a relative root against `cwd`. */
export function resolveRoot(root: string, cwd: string): string {
  if (root === "~") return homedir();
  if (root.startsWith("~/")) return join(homedir(), root.slice(2));
  return resolve(cwd, root);
}

export const gitSettings = defineSettings({
  name: "git",
  scope: "layered",
  fields: {
    /** Holds every worktree pi-git creates. Default: `<agent dir>/worktrees`. */
    worktreeRoot: string({
      default: ({ agentDir }) => join(agentDir, "worktrees"),
      trim: true,
      nonEmpty: true,
      transform: (root, { cwd }) => resolveRoot(root, cwd),
    }),
    /** Record pull requests the session only looked at, not just the ones it opened. */
    trackReferenced: bool({ default: true }),
  },
});
export type GitConfig = SettingsOf<typeof gitSettings>;
