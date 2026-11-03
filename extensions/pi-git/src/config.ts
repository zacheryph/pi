/**
 * config.ts — `~/.pi/agent/git.json`, overridden by the project's `.pi/git.json`.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadLayeredSettings } from "../../../packages/pi-foundations/src/settings.ts";

export interface GitConfig {
  /**
   * Directory that holds every worktree pi-git creates. `~/` expands to the
   * home directory; a relative path is relative to the session's cwd.
   * Default: `<agent dir>/worktrees`.
   */
  worktreeRoot: string;
}

export const CONFIG_FILE = "git.json";

export function sanitizeConfig(raw: unknown): Partial<GitConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const config: Partial<GitConfig> = {};
  if (typeof input.worktreeRoot === "string" && input.worktreeRoot.trim())
    config.worktreeRoot = input.worktreeRoot.trim();
  return config;
}

/** Expand `~/` and resolve a relative root against `cwd`. */
export function resolveRoot(root: string, cwd: string): string {
  if (root === "~") return homedir();
  if (root.startsWith("~/")) return join(homedir(), root.slice(2));
  return resolve(cwd, root);
}

export function loadGitConfig(cwd: string, agentDir = getAgentDir()): GitConfig {
  const loaded = loadLayeredSettings<GitConfig>({
    agentDir,
    cwd,
    filename: CONFIG_FILE,
    sanitize: sanitizeConfig,
    warnLabel: "pi-git",
  });
  return { worktreeRoot: resolveRoot(loaded.worktreeRoot ?? join(agentDir, "worktrees"), cwd) };
}
