/** A full, branch-scoped projection for displays; lifecycle events remain available to reactors. */
import { getLifetimeTotal, type LifetimeUsage } from "#src/lifecycle/usage";
import type { PersistedSubagentRecord } from "#src/persisted-record";
import { buildRoster, type LiveAgentLike, type RosterEntry } from "#src/roster";

export const SUBAGENT_SNAPSHOT = "subagent:snapshot";

interface SnapshotSource extends LiveAgentLike {
  readonly toolUses: number;
  readonly lifetimeUsage?: LifetimeUsage;
  readonly latestUpdate?: string;
}

export interface SubagentSnapshot {
  version: 1;
  agents: Array<RosterEntry & { toolUses: number; tokens?: number; note?: string }>;
}

/** Same membership, ordering and state derivation as subagent_get; live values override saved ones. */
export function buildSubagentSnapshot(
  records: readonly PersistedSubagentRecord[],
  getLive: (id: string) => SnapshotSource | undefined,
): SubagentSnapshot {
  const saved = new Map(records.map((record) => [record.id, record]));
  return {
    version: 1,
    agents: buildRoster(records, getLive).map((entry) => {
      const live = getLive(entry.id);
      const note =
        entry.state === "waiting"
          ? entry.waitingOn.join(", ")
          : entry.state === "running"
            ? live?.latestUpdate
            : entry.error;
      return {
        ...entry,
        toolUses: live?.toolUses ?? saved.get(entry.id)!.toolUses,
        ...(live?.lifetimeUsage ? { tokens: getLifetimeTotal(live.lifetimeUsage) } : {}),
        ...(note ? { note } : {}),
      };
    }),
  };
}
