/**
 * config.ts — Per-agent opt-in for git worktree isolation.
 *
 * Worktrees are opt-in by agent type: an agent runs in a worktree only when its
 * type appears in `worktreeAgents`. Config is read from a global file
 * (`<agentDir>/subagent:worktrees.json`) merged under a project file
 * (`<cwd>/.pi/subagent:worktrees.json`, which overrides global).
 * Missing files are silent; a malformed file warns and falls back to empty.
 *
 * Consumes the shared `loadLayeredSettings` helper from
 * the repository-local `pi-foundations` package.
 */

import { loadLayeredSettings } from "../../../packages/pi-foundations/src/settings.ts";

export interface WorktreesConfig {
  /** Agent-type names that run in a git worktree. Empty → no children isolated. */
  worktreeAgents: string[];
}

const CONFIG_FILENAME = "subagent-worktree.json";

/** Drop fields that don't match the expected shape. Silent — garbage becomes absent. */
function sanitize(raw: unknown): Partial<WorktreesConfig> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<WorktreesConfig> = {};
  if (Array.isArray(r.worktreeAgents) && r.worktreeAgents.every((x) => typeof x === "string")) {
    out.worktreeAgents = r.worktreeAgents;
  }
  return out;
}

/** Load merged config: global provides defaults, project overrides. */
export function loadWorktreesConfig(agentDir: string, cwd: string): WorktreesConfig {
  const merged = loadLayeredSettings<WorktreesConfig>({
    agentDir,
    cwd,
    filename: CONFIG_FILENAME,
    sanitize,
    warnLabel: "pi-subagent-worktree",
  });
  return { worktreeAgents: merged.worktreeAgents ?? [] };
}
