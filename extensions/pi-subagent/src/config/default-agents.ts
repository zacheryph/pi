/**
 * default-agents.ts — The built-in agent types.
 *
 * Each is a markdown file in this extension's agents/ directory, in the same
 * format as a user's .pi/agents/<name>.md, and loaded by the same parser. A
 * user file with the same name overrides one.
 */

import { fileURLToPath } from "node:url";
import { loadAgentsFromDir } from "#src/config/custom-agents";
import type { AgentConfig } from "#src/types";

/** The extension's built-in agent definitions. */
export const BUILTIN_AGENTS_DIR = fileURLToPath(new URL("../../agents/", import.meta.url));

export const DEFAULT_AGENTS: ReadonlyMap<string, AgentConfig> = loadAgentsFromDir(
  BUILTIN_AGENTS_DIR,
  "default",
);
