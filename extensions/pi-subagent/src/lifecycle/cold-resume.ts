/**
 * cold-resume.ts — Whether an agent whose live session is gone can be reopened.
 *
 * A resume normally continues the live `AgentSession`. Once that is gone (the
 * retention sweep released it, or a reload dropped the whole record) the agent's
 * transcript is still on disk, and a new session can be built around it. This
 * module answers whether that would work, so `resume` and everything that reports
 * on it (`subagent_get`, the roster card) share one check and cannot disagree.
 */

import { statSync } from "node:fs";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "#src/session/model-resolver";
import type { SubagentType } from "#src/types";

/** The facts the check reads; a `Subagent` and a saved record both satisfy it. */
export interface ReopenSource {
  readonly type: SubagentType;
  readonly outputFile?: string | undefined;
  readonly cwd?: string | undefined;
}

/** Why a transcript cannot be reopened. */
export type ReopenRefusal = "session-released" | "directory-unavailable" | "agent-type-unavailable";

/**
 * Why `source` cannot be reopened, or undefined when it can. The transcript is
 * checked first: without it there is nothing to continue, whatever else holds.
 */
export function reopenRefusal(
  source: ReopenSource,
  isUsableType: (type: SubagentType) => boolean,
): ReopenRefusal | undefined {
  if (!source.outputFile || !pathStat(source.outputFile)?.isFile()) return "session-released";
  if (!source.cwd || !pathStat(source.cwd)?.isDirectory()) return "directory-unavailable";
  if (!isUsableType(source.type)) return "agent-type-unavailable";
  return undefined;
}

function pathStat(path: string) {
  try {
    return statSync(path);
  } catch {
    // Missing or unreadable: either way it cannot be reopened.
    return undefined;
  }
}

/**
 * The model a saved `provider/id` label names, if it can still be used. Exact
 * only: a fuzzy match could continue the agent on a model it never ran. Undefined
 * leaves the session to resolve a model the way a new spawn would.
 */
export function resolveSavedModel(
  label: string | undefined,
  registry: ModelRegistry,
): Model<any> | undefined {
  const slash = label?.indexOf("/") ?? -1;
  if (!label || slash === -1) return undefined;
  const provider = label.slice(0, slash);
  const id = label.slice(slash + 1);
  const available = registry.getAvailable?.();
  if (available && !available.some((model) => model.provider === provider && model.id === id)) {
    return undefined;
  }
  return registry.find(provider, id);
}
