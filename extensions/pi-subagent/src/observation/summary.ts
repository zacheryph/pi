/**
 * The `subagent.summary` view: the branch's subagents counted by state, and the main agent's
 * profile, for badges, headers and session lists. Built from the same branch snapshot as the
 * `subagent.explorer` view, never from the widget's rows.
 */
import { plural } from "#foundations/format";
import type { SummaryCount, SummaryItem, SummaryModel, SummaryProfile } from "#surface";
import type { SubagentSnapshot } from "#src/observation/snapshot";
import type { RosterState } from "#src/roster";
import type { AgentIdentity } from "#src/types";

/** Which count each roster state adds to. */
const COUNTED: Record<
  RosterState,
  "running" | "queued" | "waiting" | "completed" | "failed" | "stopped"
> = {
  running: "running",
  queued: "queued",
  waiting: "waiting",
  completed: "completed",
  error: "failed",
  aborted: "stopped",
  stopped: "stopped",
  interrupted: "stopped",
};

/** The main agent's profile as a summary shows it: its name, display name and description. */
export function summaryProfile(
  profile: Pick<AgentIdentity, "name" | "displayName" | "description">,
): SummaryProfile | undefined {
  const name = profile.name.trim();
  if (!name) return undefined;
  const label = profile.displayName?.trim();
  const description = profile.description.trim();
  return {
    name,
    ...(label && label !== name ? { label } : {}),
    ...(description ? { description } : {}),
  };
}

/**
 * Every count is present, zero included, so a session with no subagents reads zeros where one
 * without pi-subagent has no view. Running, queued and waiting agents live only in this process,
 * so those counts are `live`: a saved summary reads 0 for them. Finished agents are the branch's
 * history and stay; `total` counts every agent on the branch, whatever its state, and stays too.
 * So `total` minus the running, queued and waiting counts is the finished agents both live and
 * settled: settled, it includes the agents that stopped with the process, as the widget's and
 * explorer's settled rows read "stopped".
 *
 * `active` is the newest running agent, by its id; it is `live`, so a saved summary has none.
 * `displayName` names an agent type as the widget and explorer do. `total`'s label agrees with
 * its value ("1 subagent"); the state counts read the same for any value, live ones settled to 0
 * included.
 */
export function subagentSummaryModel(
  snapshot: SubagentSnapshot,
  profile?: Pick<AgentIdentity, "name" | "displayName" | "description">,
  displayName: (type: string) => string = (type) => type,
): SummaryModel {
  const by = { running: 0, queued: 0, waiting: 0, completed: 0, failed: 0, stopped: 0 };
  for (const agent of snapshot.agents) by[COUNTED[agent.state]]++;
  const counts: SummaryCount[] = [
    { key: "running", label: "running", value: by.running, tone: "accent", live: true },
    { key: "queued", label: "queued", value: by.queued, tone: "dim", live: true },
    { key: "waiting", label: "waiting", value: by.waiting, tone: "muted", live: true },
    { key: "completed", label: "done", value: by.completed, tone: "success" },
    { key: "failed", label: "failed", value: by.failed, tone: "error" },
    { key: "stopped", label: "stopped", value: by.stopped, tone: "dim" },
    {
      key: "total",
      label: plural(snapshot.agents.length, "subagent"),
      value: snapshot.agents.length,
    },
  ];
  // Roster order puts the newest running agent first.
  const running = snapshot.agents.find((agent) => agent.state === "running");
  const active: SummaryItem | undefined = running && {
    id: running.id,
    label: [displayName(running.type), running.description].filter(Boolean).join(": "),
    live: true,
  };
  const shown = profile && summaryProfile(profile);
  return { counts, ...(active ? { active } : {}), ...(shown ? { profile: shown } : {}) };
}
