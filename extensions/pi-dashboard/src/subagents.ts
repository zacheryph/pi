import type { SubagentsSection, SubagentState } from "./protocol.ts";
import { clip } from "./sections.ts";

/** pi-subagent lifecycle channels on the session's pi.events bus. */
export const SUBAGENT_CHANNELS = [
  "subagent:created",
  "subagent:started",
  "subagent:queued",
  "subagent:waiting",
  "subagent:resuming",
  "subagent:notified",
  "subagent:completed",
  "subagent:failed",
  "subagent:resumed",
] as const;

const MAX_AGENTS = 20;
type Agent = SubagentsSection["agents"][number];

const TERMINAL: Record<string, SubagentState> = {
  completed: "completed",
  error: "failed",
  aborted: "stopped",
  stopped: "stopped",
};

/**
 * Follows subagents through pi-subagent's lifecycle events, which arrive on
 * this session's own bus. Events cover this session's agents only, and need no
 * lookup in pi-subagent's process-wide service registry.
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
      id,
      type: clip(raw.type, 64) ?? "agent",
      description: clip(raw.description, 200) ?? "",
      state: "queued",
      since: this.now(),
    };
    switch (channel) {
      case "subagent:created":
        if (existing) return false;
        break;
      case "subagent:queued":
        // A finished agent given a message, waiting for a concurrency slot.
        agent.state = "queued";
        delete agent.note;
        break;
      case "subagent:waiting": {
        // A run ended with work open: idle, not done. The note names what it waits on.
        agent.state = "waiting";
        const reason = clip(raw.reason, 300);
        if (reason) agent.note = reason;
        else delete agent.note;
        break;
      }
      case "subagent:started":
      case "subagent:resuming":
        agent.state = "running";
        delete agent.note;
        break;
      case "subagent:notified": {
        const note = clip(raw.message, 300);
        if (note) agent.note = note;
        break;
      }
      case "subagent:completed":
      case "subagent:failed":
      case "subagent:resumed": {
        agent.state =
          TERMINAL[String(raw.status)] ?? (channel === "subagent:failed" ? "failed" : "completed");
        // What the agent waited on is over: the note is the error of a failure, or nothing.
        delete agent.note;
        const error = clip(raw.error, 300);
        if (error) agent.note = error;
        if (typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs))
          agent.durationMs = Math.max(0, raw.durationMs);
        if (typeof raw.toolUses === "number" && Number.isSafeInteger(raw.toolUses))
          agent.toolUses = raw.toolUses;
        const tokens = (raw.tokens as { total?: unknown } | undefined)?.total;
        if (typeof tokens === "number" && Number.isFinite(tokens)) agent.tokens = tokens;
        break;
      }
      default:
        return false;
    }
    this.agents.delete(id);
    this.agents.set(id, agent);
    // Keep running agents; trim the oldest finished ones.
    while (this.agents.size > MAX_AGENTS) {
      const oldest = [...this.agents.values()].find(
        (candidate) =>
          candidate.state !== "running" &&
          candidate.state !== "queued" &&
          candidate.state !== "waiting",
      );
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
