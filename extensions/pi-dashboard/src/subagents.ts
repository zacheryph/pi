import type { SubagentsSection, SubagentState } from "./protocol.ts";
import { clip } from "./sections.ts";

export const SUBAGENT_SNAPSHOT_EVENT = "subagent:snapshot";
const MAX_AGENTS = 20;
const STATES: Readonly<Record<string, SubagentState>> = {
  queued: "queued",
  running: "running",
  waiting: "waiting",
  completed: "completed",
  error: "failed",
  aborted: "stopped",
  stopped: "stopped",
  interrupted: "stopped",
};
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** A validated projection of the producer's current branch, never an event-derived state machine. */
export class SubagentTracker {
  private current: SubagentsSection | undefined;

  /** A valid full snapshot replaces the previous branch, including an empty one. */
  apply(data: unknown): boolean {
    if (!data || typeof data !== "object") return false;
    const snapshot = data as { version?: unknown; agents?: unknown };
    if (snapshot.version !== 1 || !Array.isArray(snapshot.agents)) return false;
    const agents: SubagentsSection["agents"] = [];
    for (const item of snapshot.agents.slice(0, 1000)) {
      if (!item || typeof item !== "object") continue;
      const raw = item as Record<string, unknown>;
      const id = clip(raw.id, 64);
      const state =
        typeof raw.state === "string" && Object.hasOwn(STATES, raw.state)
          ? STATES[raw.state]
          : undefined;
      if (!id || !state || !number(raw.startedAt)) continue;
      const note =
        clip(raw.note, 300) ?? (raw.state === "interrupted" ? "Run interrupted" : undefined);
      const durationMs = number(raw.completedAt)
        ? Math.max(0, raw.completedAt - raw.startedAt)
        : undefined;
      agents.push({
        id,
        type: clip(raw.type, 64) ?? "agent",
        description: clip(raw.description, 200) ?? "",
        state,
        since: raw.startedAt,
        ...(note ? { note } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(number(raw.toolUses) ? { toolUses: Math.floor(raw.toolUses) } : {}),
        ...(number(raw.tokens) ? { tokens: raw.tokens } : {}),
      });
    }
    const active = agents.filter((agent) => ["queued", "running", "waiting"].includes(agent.state));
    const activeIds = new Set(active.map((agent) => agent.id));
    const finished = agents.filter((agent) => !activeIds.has(agent.id));
    this.current = agents.length
      ? { agents: [...active, ...finished.slice(0, Math.max(0, MAX_AGENTS - active.length))] }
      : undefined;
    return true;
  }

  section(): SubagentsSection | undefined {
    return this.current && { agents: this.current.agents.map((agent) => ({ ...agent })) };
  }
}
