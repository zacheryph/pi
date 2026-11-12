import {
  SUBAGENT_SNAPSHOT_VERSION,
  type SubagentSnapshot,
} from "../../pi-subagent/src/observation/snapshot.ts";
import type { SubagentsSection, SubagentState } from "./protocol.ts";
import { clip } from "./sections.ts";

const MAX_AGENTS = 20;
const STATES: Readonly<Record<SubagentSnapshot["agents"][number]["state"], SubagentState>> = {
  queued: "queued",
  running: "running",
  waiting: "waiting",
  completed: "completed",
  error: "failed",
  aborted: "stopped",
  stopped: "stopped",
  interrupted: "stopped",
};

/** A typed projection of the producer's current branch, never an event-derived state machine. */
export class SubagentTracker {
  private current: SubagentsSection | undefined;

  /** A valid full snapshot replaces the previous branch, including an empty one. */
  apply(data: SubagentSnapshot | undefined): boolean {
    if (data?.version !== SUBAGENT_SNAPSHOT_VERSION) return false;
    const agents: SubagentsSection["agents"] = [];
    for (const raw of data.agents.slice(0, 1000)) {
      const id = clip(raw.id, 64);
      if (!id) continue;
      const note =
        clip(raw.note, 300) ?? (raw.state === "interrupted" ? "Run interrupted" : undefined);
      const durationMs =
        raw.completedAt !== undefined ? Math.max(0, raw.completedAt - raw.startedAt) : undefined;
      agents.push({
        id,
        type: clip(raw.type, 64) ?? "agent",
        description: clip(raw.description, 200) ?? "",
        state: STATES[raw.state],
        since: raw.startedAt,
        ...(note ? { note } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        toolUses: raw.toolUses,
        ...(raw.tokens !== undefined ? { tokens: raw.tokens } : {}),
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
