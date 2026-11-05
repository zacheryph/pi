/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .pi/agents/*.md.
 * User agents override defaults with the same name. Disabled agents are kept but
 * refused at spawn; hidden agents spawn by name but stay out of the tool's list.
 */

import { DEFAULT_AGENTS } from "#src/config/default-agents";
import type { AgentConfig } from "#src/types";

// ── AgentConfigLookup interface ──────────────────────────────────────────────

/**
 * Narrow registry interface for consumers that only need config resolution.
 * Prefer this over the full `AgentTypeRegistry` in function signatures (ISP).
 */
export interface AgentConfigLookup {
  resolveAgentConfig(type: string): AgentConfig;
  getToolNamesForType(type: string): string[];
}

// ── AgentTypeRegistry class ──────────────────────────────────────────────────

/**
 * Injectable registry of all agent configurations (defaults + user-defined).
 *
 * Replaces the module-scoped `agents` Map and its companion free functions.
 * The constructor accepts a `loadUserAgents` callback to defer disk I/O to the
 * call site, keeping this class side-effect-free and easy to test.
 */
export class AgentTypeRegistry implements AgentConfigLookup {
  private agents = new Map<string, AgentConfig>();

  /** The embedded default agent names. */
  static readonly DEFAULT_AGENT_NAMES = [
    "general-purpose",
    "orchestrator",
    "Explore",
    "Plan",
    "reviewer",
  ] as const;

  constructor(private loadUserAgents: () => Map<string, AgentConfig>) {
    this.reload();
  }

  /**
   * Re-scan user agents and rebuild the registry.
   * Starts with DEFAULT_AGENTS, then overlays whatever `loadUserAgents()` returns.
   */
  reload(): void {
    this.agents.clear();
    for (const [name, config] of DEFAULT_AGENTS) {
      this.agents.set(name, config);
    }
    for (const [name, config] of this.loadUserAgents()) {
      this.agents.set(name, config);
    }
  }

  /** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
  resolveType(name: string): string | undefined {
    return this.resolveKey(name);
  }

  /** Get every type that can be spawned: visible and hidden, not disabled. */
  getAvailableTypes(): string[] {
    return [...this.agents.entries()]
      .filter(([, config]) => isSpawnable(config))
      .map(([name]) => name);
  }

  /** Get the types the subagent_start description lists: visible only. */
  getListedTypes(): string[] {
    return [...this.agents.entries()]
      .filter(([, config]) => isListed(config))
      .map(([name]) => name);
  }

  /** Get all type names, hidden and disabled included (for UI listing). */
  getAllTypes(): string[] {
    return [...this.agents.keys()];
  }

  /** Get names of default agents currently in the registry. */
  getDefaultAgentNames(): string[] {
    return [...this.agents.entries()]
      .filter(([, config]) => config.isDefault === true)
      .map(([name]) => name);
  }

  /** Get names of user-defined agents (non-defaults) currently in the registry. */
  getUserAgentNames(): string[] {
    return [...this.agents.entries()]
      .filter(([, config]) => config.isDefault !== true)
      .map(([name]) => name);
  }

  /** Check if a type exists and is not disabled (case-insensitive). Hidden types are valid. */
  isValidType(type: string): boolean {
    const key = this.resolveKey(type);
    if (!key) return false;
    const config = this.agents.get(key);
    return config !== undefined && isSpawnable(config);
  }

  /**
   * Get the capability tool names for a type (case-insensitive).
   *
   * An agent that declares no `tools:` key gets all available tools; one that declares
   * `tools: none` gets nothing. Resolution goes through `resolveAgentConfig` so
   * the two cannot disagree about which config a type names.
   */
  getToolNamesForType(type: string): string[] {
    return this.resolveAgentConfig(type).toolNames ?? ["all"];
  }

  /** Resolve agent config with guaranteed non-null return. Falls back: unknown → general-purpose → absolute fallback. */
  resolveAgentConfig(type: string): AgentConfig {
    const key = this.resolveKey(type);
    const config = key ? this.agents.get(key) : undefined;
    if (config) return config;

    const gp = this.agents.get("general-purpose");
    if (gp) return gp;

    // Absolute fallback (should never happen in practice)
    return {
      name: type,
      displayName: "Agent",
      description: "General-purpose agent for complex, multi-step tasks",
      toolNames: ["all"],
      systemPrompt: "",
      promptMode: "append",
    };
  }

  private resolveKey(name: string): string | undefined {
    if (this.agents.has(name)) return name;
    const lower = name.toLowerCase();
    for (const key of this.agents.keys()) {
      if (key.toLowerCase() === lower) return key;
    }
    return undefined;
  }
}

/** True unless the agent is disabled. */
export function isSpawnable(config: Pick<AgentConfig, "visibility">): boolean {
  return config.visibility !== "disabled";
}

/** True when the agent belongs in the subagent_start list: visible, or no visibility set. */
export function isListed(config: Pick<AgentConfig, "visibility">): boolean {
  return (config.visibility ?? "visible") === "visible";
}

/** All known built-in tool names. */
export const BUILTIN_TOOL_NAMES: string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
