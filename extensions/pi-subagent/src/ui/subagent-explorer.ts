/**
 * The branch's subagents as a pi-surface explorer: the `subagent.explorer` view a remote
 * surface draws. One item per agent of the roster, newest state first, with its facts inline.
 * Descriptions, notes and errors are untrusted text; every renderer sanitizes them.
 */

import type { Block, ExplorerItem, ExplorerModel, Tone } from "#surface";
import type { AgentConfigLookup } from "#src/config/agent-types";
import type { SubagentSnapshot } from "#src/observation/snapshot";
import type { RosterState } from "#src/roster";
import { formatMs, getDisplayName } from "#src/ui/display";

type Agent = SubagentSnapshot["agents"][number];

const STATE: Record<RosterState, { label: string; tone: Tone }> = {
  running: { label: "running", tone: "accent" },
  queued: { label: "queued", tone: "dim" },
  waiting: { label: "waiting", tone: "muted" },
  completed: { label: "done", tone: "success" },
  error: { label: "error", tone: "error" },
  aborted: { label: "aborted", tone: "warning" },
  interrupted: { label: "interrupted", tone: "warning" },
  stopped: { label: "stopped", tone: "dim" },
};

/** States only a running process holds (see pi-surface's `live`), and what a saved badge reads. */
const LIVE: ReadonlySet<RosterState> = new Set(["running", "queued", "waiting"]);
const SETTLED = { text: STATE.stopped.label, tone: STATE.stopped.tone };

/** What a note means in each state: a waiting agent's open work, a running one's last update. */
function noteHeading(state: RosterState): string {
  if (state === "waiting") return "Waiting on";
  if (state === "running") return "Latest update";
  return "Error";
}

function detail(agent: Agent, name: string): Block[] {
  const { label, tone } = STATE[agent.state];
  const blocks: Block[] = [
    {
      fields: [
        ["Agent", name],
        ["Id", agent.id],
        ["State", { text: label, tone }],
        ["Started", new Date(agent.startedAt).toISOString()],
        // Only a finished run's duration: a running one would be stale as soon as it is read.
        ...(agent.completedAt !== undefined
          ? ([["Duration", formatMs(Math.max(0, agent.completedAt - agent.startedAt))]] as const)
          : []),
        ["Tool uses", String(agent.toolUses)],
        ...(agent.tokens !== undefined ? ([["Tokens", String(agent.tokens)]] as const) : []),
      ],
    },
  ];
  if (agent.note)
    blocks.push(
      { heading: noteHeading(agent.state) },
      { text: agent.note, ...(agent.state === "error" ? { tone: "error" as const } : {}) },
    );
  blocks.push({
    text: "subagent_get reports its result; /subagent:sessions shows its transcript.",
    tone: "muted",
  });
  return blocks;
}

export function subagentExplorerModel(
  snapshot: SubagentSnapshot,
  registry: AgentConfigLookup,
): ExplorerModel {
  const items = snapshot.agents.map((agent): ExplorerItem => {
    const name = getDisplayName(agent.type, registry);
    const { label, tone } = STATE[agent.state];
    return {
      id: agent.id,
      label: [
        { text: name, tone: "accent" },
        { text: ` — ${agent.description}`, tone: "muted" },
      ],
      search: `${agent.id} ${agent.type} ${agent.note ?? ""}`,
      // A running, queued or waiting agent lives in this process: a saved list reads "stopped".
      badge: { text: label, tone, ...(LIVE.has(agent.state) ? { live: { ...SETTLED } } : {}) },
      detail: detail(agent, name),
    };
  });
  return {
    title: "Subagents",
    noun: ["subagent", "subagents"],
    items,
    tabs: [
      { label: "All", ids: items.map((item) => item.id) },
      {
        label: "Active",
        ids: snapshot.agents.filter((agent) => LIVE.has(agent.state)).map((agent) => agent.id),
        emptyText: "No subagent is running, queued or waiting.",
      },
    ],
    emptyText: "No subagents on this branch.",
    hints: [{ keys: "/subagent:sessions", action: "transcripts" }],
  };
}
