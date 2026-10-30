import type { SubagentsSection, SubagentState } from "./protocol.ts";
import { clip } from "./sections.ts";

/** pi-subagents lifecycle channels on the session's pi.events bus. */
export const SUBAGENT_CHANNELS = [
  "subagents:created", "subagents:started", "subagents:resuming", "subagents:update",
  "subagents:completed", "subagents:failed", "subagents:resumed",
] as const;

const MAX_AGENTS = 20;
type Agent = SubagentsSection["agents"][number];

const TERMINAL: Record<string, SubagentState> = {
  completed: "completed", error: "failed", aborted: "stopped", stopped: "stopped",
};

/**
 * Follows subagents through pi-subagents' lifecycle events. pi-subagents also
 * publishes a service on globalThis, but subagent children load the same
 * extension in-process and replace it; the event bus is per session.
 * Agents that started before this runtime loaded are not known.
 */
export class SubagentTracker {
  private readonly agents = new Map<string, Agent>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Returns whether the event changed anything. */
  apply(channel: string, data: unknown): boolean {
    if (!data || typeof data !== "object") return false;
    const raw = data as Record<string, unknown>;
    const id = clip(raw.id, 64);
    if (!id) return false;
    const existing = this.agents.get(id);
    const agent: Agent = existing ?? {
      id, type: clip(raw.type, 64) ?? "agent", description: clip(raw.description, 200) ?? "", state: "queued", since: this.now(),
    };
    switch (channel) {
      case "subagents:created": if (existing) return false; break;
      case "subagents:started":
      case "subagents:resuming": agent.state = "running"; delete agent.note; break;
      case "subagents:update": { const note = clip(raw.message, 300); if (note) agent.note = note; break; }
      case "subagents:completed":
      case "subagents:failed":
      case "subagents:resumed": {
        agent.state = TERMINAL[String(raw.status)] ?? (channel === "subagents:failed" ? "failed" : "completed");
        const error = clip(raw.error, 300);
        if (error) agent.note = error;
        if (typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs)) agent.durationMs = Math.max(0, raw.durationMs);
        if (typeof raw.toolUses === "number" && Number.isSafeInteger(raw.toolUses)) agent.toolUses = raw.toolUses;
        const tokens = (raw.tokens as { total?: unknown } | undefined)?.total;
        if (typeof tokens === "number" && Number.isFinite(tokens)) agent.tokens = tokens;
        break;
      }
      default: return false;
    }
    this.agents.delete(id);
    this.agents.set(id, agent);
    // Keep running agents; trim the oldest finished ones.
    while (this.agents.size > MAX_AGENTS) {
      const oldest = [...this.agents.values()].find((candidate) => candidate.state !== "running" && candidate.state !== "queued");
      if (!oldest) break;
      this.agents.delete(oldest.id);
    }
    return true;
  }

  section(): SubagentsSection | undefined {
    if (!this.agents.size) return undefined;
    return { agents: [...this.agents.values()].reverse().map((agent) => ({ ...agent })) };
  }
}
