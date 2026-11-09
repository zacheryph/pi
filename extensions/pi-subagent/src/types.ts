/**
 * types.ts — Type definitions for the subagent system.
 */

import type { Model } from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
  SessionContext as SdkSessionContext,
} from "@earendil-works/pi-coding-agent";
import type { LockDeclaration } from "#src/config/invocation-config";
import type { SubagentThinkingLevel } from "#src/config/thinking-level";
import type { ModelRegistry } from "#src/session/model-resolver";

export type { SteerOutcome } from "#src/lifecycle/subagent";
export { Subagent } from "#src/lifecycle/subagent";
export type { AgentSessionEvent };

/**
 * The thinking levels this package accepts.
 *
 * Wider than pi-ai's `ThinkingLevel`, which omits `off` — Pi honors it, and agent
 * frontmatter has always documented it.
 */
export type ThinkingLevel = SubagentThinkingLevel;

/**
 * How a child adopts its parent's prompt as its own identity.
 *
 * `full` embeds the parent's assembled prompt minus Pi's per-session layers —
 * a leading prefix the child shares with its parent (ADR 0006, ADR 0008).
 * `portable` embeds only the parent's operator-authored parts, for a child
 * whose provider re-homes the prompt into another harness that supplies its
 * own base (ADR 0009).
 */
export type PromptInheritance = "full" | "portable";

/**
 * One message in a child session's history, typed from Pi's `SessionContext`.
 *
 * Derived from the barrel-exported `SessionContext` (whose `messages` field is
 * `AgentMessage[]`) so the package needs no direct dependency on
 * `@earendil-works/pi-agent-core`, which is not re-exported from the public barrel.
 */
export type SessionMessage = SdkSessionContext["messages"][number];

/**
 * Narrow session interface for event subscription.
 * Used by record-observer — only the subscribe method is needed.
 */
export interface SubscribableSession {
  subscribe(fn: (event: AgentSessionEvent) => void): () => void;
}

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** UI display and agent listing — name, display name, description, prompt mode. */
export interface AgentIdentity {
  name: string;
  displayName?: string;
  description: string;
  promptMode: "replace" | "append";
}

/** Prompt assembly — name, prompt mode, system prompt. */
export interface AgentPromptConfig {
  name: string;
  promptMode: "replace" | "append";
  systemPrompt: string;
}

/** Where an agent definition file was found. `default` is the extension's own agents/ directory. */
export type AgentSource = "default" | "project" | "global";

/** The `visibility` values an agent file may declare. */
export const AGENT_VISIBILITIES = ["visible", "hidden", "disabled"] as const;

export type AgentVisibility = (typeof AGENT_VISIBILITIES)[number];

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig extends AgentIdentity, AgentPromptConfig {
  /** Tool selectors: omitted or `all` inherits available tools; explicit names restrict, `-name` excludes (MCP globs supported). */
  toolNames?: string[];
  /**
   * true lets a child start, read and steer agents of its own (subagent_start,
   * subagent_get, subagent_steer). Omitted or false withholds them, whatever
   * `toolNames` selects. A main session always has them unless `tools` excludes them.
   */
  delegate?: boolean;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  /** Default for spawn: fork parent conversation. undefined = caller decides. */
  inheritContext?: boolean;
  /** Fields a `subagent_start` tool caller may not override. Omitted — every field is overridable. */
  locked?: LockDeclaration;
  /** When to pick this agent, shown after its description in the subagent_start list. */
  guidance?: string;
  /**
   * Who can see and run this agent. Omitted means `visible`.
   * - `visible`: listed in the subagent_start description and spawnable.
   * - `hidden`: spawnable by name, but left out of the list, for agents a
   *   skill or another agent names explicitly.
   * - `disabled`: refused everywhere.
   */
  visibility?: AgentVisibility;
  /** Where this agent was loaded from: the extension's built-ins, or a user directory. */
  source?: AgentSource;
  /** Path of the winning agent definition file. */
  sourcePath?: string;
  /** Ordered fragment names in the winning profile's agents/fragments directory. */
  fragments?: string[];
  /**
   * The file could not be parsed. The agent is kept so it still overrides a
   * lower-priority one, but it is unlisted, refused at spawn, and shown with
   * this message in /subagent:agents.
   */
  definitionError?: string;
  /** Invalid fragment declaration: discoverable, but refused at execution/preview. */
  fragmentError?: string;
}

export interface AgentInvocation {
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext?: boolean;
}

/**
 * Narrow interface capturing the ExtensionContext fields SubagentRuntime needs.
 * Avoids coupling runtime to the full SDK ExtensionContext surface (ISP).
 */
export interface SessionContext {
  readonly cwd: string;
  readonly model: Model<any> | undefined;
  readonly modelRegistry: ModelRegistry;
  getSystemPrompt(): string;
  /** Trust captured at spawn; absent means not trusted for project fragment reads. */
  isProjectTrusted?(): boolean;
  readonly sessionManager: {
    getSessionFile(): string | undefined;
    getSessionId(): string;
    getBranch(): unknown[];
  };
}

/**
 * Narrow shell-exec callback replacing `ExtensionAPI` in `detectEnv()`.
 * Matches the shape of `pi.exec()` without carrying an SDK dependency.
 */
export type ShellExec = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Parent session identity — grouped fields that travel together from the tool boundary. */
export interface ParentSessionInfo {
  /** Path to the parent session's JSONL file (for deriving the subagent session directory). */
  parentSessionFile?: string;
  /** Session ID of the parent agent (stored in the child session's parentSession header). */
  parentSessionId?: string;
  /** Tool call ID for background notification wiring. Exposed on the record via Subagent.toolCallId. */
  toolCallId?: string;
}

/** Compaction event info passed through lifecycle observers. */
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };
