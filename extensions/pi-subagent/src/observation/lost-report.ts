/**
 * lost-report.ts - the one message a parent hears when it starts, about the agents that lost work
 * to the reload or restart that ended its previous instance (roadmap step 12).
 *
 * A reload or restart ends what cannot survive it: a child's own subagents, and after a restart
 * its jobs. Each agent that lost something is told in its own transcript by its own work host.
 * The parent hears it once, here: every agent that lost work or whose run was cut short, and what
 * it lost, in one message. It starts no turn and restarts nothing: the parent or the user decides
 * whether the work is still needed and gives the agent more with `subagent_send`.
 */
import type { Json, WorkMessage } from "#work";
import { clipText as clipOneLine } from "#src/roster";

/** The custom message type of the report. */
export const LOST_TYPE = "subagent:lost";

/** One thing an agent lost: an item of its own (`watch`, `subagent`, ...) or only its label. */
export interface LostWork {
  kind?: string;
  label: string;
}

/** What one agent lost. */
export interface LostAgent {
  id: string;
  type: string;
  description: string;
  /** Its run was in progress, and was cut short. */
  interrupted: boolean;
  /** The open work nobody could take over. */
  lost: readonly LostWork[];
  /** What it still waits on (a question, a job kept across a reload), if anything. */
  waitingOn: readonly string[];
  /**
   * Its session could not be reopened in time at startup. Nothing is known about its work, so it is
   * not claimed lost: it was not checked, and `subagent_send` reopens it.
   */
  timedOut?: boolean;
}

/**
 * Details the report carries, bounded like the text: at most `MAX_AGENTS` agents and `MAX_ITEMS`
 * items of each list, every text clipped, with the counts of what was left out so nothing is
 * dropped silently. The details are written into the parent's session file, so they must not grow
 * with a hostile or huge input.
 */
export interface LostDetails {
  /** Every agent the report is about, including those not spelled out in `agents`. */
  totalAgents: number;
  agents: {
    id: string;
    type: string;
    description: string;
    interrupted: boolean;
    timedOut: boolean;
    lost: LostWork[];
    /** How many items it lost, including those not spelled out in `lost`. */
    lostCount: number;
    waitingOn: string[];
    waitingOnCount: number;
  }[];
}

/**
 * One sanitised line cut to `max` characters. A hostile input can be megabytes long, and segmenting
 * all of it just to throw it away is the cost, so only the head that could survive is looked at.
 */
const clipText = (text: string, max: number): string =>
  clipOneLine(text.length > max * 8 ? text.slice(0, max * 8) : text, max);

const LINE_DESCRIPTION = 80;
const LINE_ITEM = 100;
/** The longest text of a field in the details. */
const DETAIL_TEXT = 200;
const DETAIL_ID = 40;
/** The most agents the message and the details spell out. */
const MAX_AGENTS = 30;
/** The most items of each kind of list spelled out for one agent. */
const MAX_ITEMS = 8;

/** A text as one line inside double quotes: a quote or backslash in it is escaped, so it cannot end the quoted text early. */
const quoted = (text: string, max: number): string =>
  `"${clipText(text, max).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const item = (work: LostWork): string =>
  `${work.kind ? `${clipText(work.kind, LINE_DESCRIPTION)} ` : ""}${quoted(work.label, LINE_ITEM)}`;

function line(agent: LostAgent): string {
  const parts: string[] = [];
  if (agent.interrupted) parts.push("its run was interrupted and did not finish");
  if (agent.lost.length > 0) {
    const shown = agent.lost.slice(0, MAX_ITEMS).map(item);
    if (agent.lost.length > MAX_ITEMS) shown.push(`and ${agent.lost.length - MAX_ITEMS} more`);
    parts.push(`lost ${shown.join(", ")}`);
  }
  if (agent.waitingOn.length > 0) {
    const shown = agent.waitingOn.slice(0, MAX_ITEMS).map((label) => quoted(label, LINE_ITEM));
    if (agent.waitingOn.length > MAX_ITEMS)
      shown.push(`and ${agent.waitingOn.length - MAX_ITEMS} more`);
    parts.push(`still waiting on ${shown.join(", ")}`);
  }
  if (agent.timedOut)
    parts.push(
      "could not be reopened at startup (opening its session took too long), so its work was not checked",
    );
  const id = clipText(agent.id, DETAIL_ID);
  const type = clipText(agent.type, LINE_DESCRIPTION);
  return `- ${id} ${type} ${quoted(agent.description, LINE_DESCRIPTION)}: ${parts.join("; ")}`;
}

const detailItem = (work: LostWork): LostWork => ({
  ...(work.kind !== undefined ? { kind: clipText(work.kind, DETAIL_TEXT) } : {}),
  label: clipText(work.label, DETAIL_TEXT),
});

function detail(agent: LostAgent): LostDetails["agents"][number] {
  return {
    id: clipText(agent.id, DETAIL_ID),
    type: clipText(agent.type, DETAIL_TEXT),
    description: clipText(agent.description, DETAIL_TEXT),
    interrupted: agent.interrupted,
    timedOut: agent.timedOut === true,
    lost: agent.lost.slice(0, MAX_ITEMS).map(detailItem),
    lostCount: agent.lost.length,
    waitingOn: agent.waitingOn.slice(0, MAX_ITEMS).map((label) => clipText(label, DETAIL_TEXT)),
    waitingOnCount: agent.waitingOn.length,
  };
}

/**
 * The report, or undefined when no agent has anything to report: lost work, an interrupted run, or
 * a session that could not be reopened in time. Data only: the content is plain text with every
 * agent's text clipped, quoted and sanitised to one line, and the details are bounded the same way.
 */
export function lostReport(agents: readonly LostAgent[]): WorkMessage | undefined {
  const reported = agents.filter(
    (agent) => agent.interrupted || agent.lost.length > 0 || agent.timedOut,
  );
  if (reported.length === 0) return undefined;
  const noun = reported.length === 1 ? "agent" : "agents";
  const lines = reported.slice(0, MAX_AGENTS).map(line);
  if (reported.length > MAX_AGENTS)
    lines.push(`- and ${reported.length - MAX_AGENTS} more ${noun}`);
  const details: LostDetails = {
    totalAgents: reported.length,
    agents: reported.slice(0, MAX_AGENTS).map(detail),
  };
  const unchecked = reported.some((agent) => agent.timedOut)
    ? " An agent that could not be reopened at startup was not checked: its work may still be open in its own transcript, and subagent_send reopens it."
    : "";
  const timedOut = reported.filter((agent) => agent.timedOut).length;
  // An agent that could not be reopened is not known to have lost anything: the header says so.
  const header =
    timedOut === 0
      ? `Subagent work lost: ${reported.length} ${noun} lost work when this session was reloaded or restarted. `
      : `Subagent startup report: ${reported.length} ${noun} to report when this session was reloaded or restarted (${reported.length - timedOut} lost work or ${reported.length - timedOut === 1 ? "was" : "were"} interrupted, ${timedOut} could not be reopened). `;
  return {
    customType: LOST_TYPE,
    content:
      header +
      "Nothing was restarted, and nothing will wake you for the work that was lost. Each agent was told " +
      "what it lost in its own transcript and is idle, apart from what it still waits on. Decide whether the " +
      'work is still needed, and give an agent more with subagent_send("<id>", "...").' +
      unchecked +
      "\n" +
      lines.join("\n"),
    details: details as unknown as Json,
  };
}
