import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentConfigLookup } from "#src/config/agent-types";
import type { ReopenSource } from "#src/lifecycle/cold-resume";
import type { SendRefusal } from "#src/lifecycle/subagent";
import { displayStatus } from "#src/lifecycle/subagent-state";
import { SUBAGENT_LIST_KIND } from "#src/handlers/roster-card";
import type { PersistedSubagentRecord } from "#src/persisted-record";
import { buildRoster, formatRosterList, readBranchRecords } from "#src/roster";
import {
  type GetResultDetails,
  PREVIEW_CHARS,
  renderGetResultLines,
} from "#src/tools/get-result-renderer";
import {
  type AgentReport,
  formatAgentReport,
  formatSavedAgentReport,
} from "#src/tools/get-result-report";
import { formatLifetimeTokens, textResult } from "#src/tools/helpers";
import type { Subagent } from "#src/types";
import { formatAgentDuration, getDisplayName, modelLabel, type Theme } from "#src/ui/display";
import { BoundedLines, bodyRow, ICONS } from "../../../../packages/pi-ui/src/index.ts";

// ---- Deps interfaces ----

export interface GetResultToolManager {
  getRecord(id: string): Subagent | undefined;
  listAgents(): Subagent[];
  /** The check `send` itself makes, so this report cannot promise what it refuses. */
  sendRefusalFor(source: { id: string } & ReopenSource): SendRefusal | undefined;
}

/** What a `subagent_get` list result carries for the TUI and the roster card's stop rule. */
export interface GetListDetails {
  kind: typeof SUBAGENT_LIST_KIND;
  total: number;
}

type GetParams = { agent_id?: string; verbose?: boolean };

/** The reply for an ID this branch never started. */
export function agentNotFoundMessage(id: string): string {
  return (
    `Agent not found: "${id}". No agent with this ID was started on this branch of the ` +
    "session. Call subagent_get without agent_id to list the agents that were."
  );
}

// ---- Class ----

export class GetResultTool {
  constructor(
    private readonly manager: GetResultToolManager,
    private readonly registry: AgentConfigLookup,
  ) {}

  /**
   * Report on one agent.
   *
   * The branch decides which agents this call can see: an agent started on a
   * branch /tree has left is gone with it, live or not. Without a session to
   * read (a bare call outside Pi), every live agent is visible.
   */
  async execute(
    _toolCallId: string,
    params: GetParams & { agent_id: string },
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: unknown,
  ) {
    const branch = readBranchRecords(ctx);
    const id = params.agent_id;
    const saved = branch?.find((candidate) => candidate.id === id);
    const live = this.manager.getRecord(id);
    const record = live && (branch === undefined || saved) ? live : undefined;
    if (!record) {
      if (saved) return this.savedResult(saved, params.verbose === true);
      return textResult<GetResultDetails>(agentNotFoundMessage(id));
    }

    // Reading a finished result starts the short retention window for the
    // agent's session. It does not touch the completion message, which is
    // delivered whatever the parent has read. An agent still waiting on work has no finished
    // result to read, so it does not count.
    if (record.isDone()) record.markConsumed();

    const verbose = params.verbose === true;
    return textResult<GetResultDetails>(
      formatAgentReport(this.buildReport(record, verbose)),
      this.buildGetResultDetails(record, verbose),
    );
  }

  /** List the branch's agents, with live state wherever a live agent backs one. */
  list(ctx: unknown) {
    const branch = readBranchRecords(ctx);
    const getLive = (id: string) => this.manager.getRecord(id);
    const entries = buildRoster(
      branch ?? this.manager.listAgents(),
      getLive,
      (source) => this.manager.sendRefusalFor(source) === undefined,
    );
    return textResult<GetListDetails>(formatRosterList(entries), {
      kind: SUBAGENT_LIST_KIND,
      total: entries.length,
    });
  }

  /** Answer from the branch's last record for an agent no live record backs. */
  private savedResult(saved: PersistedSubagentRecord, verbose: boolean) {
    // Still queued or running with no live agent behind it, or already read back as interrupted.
    const interrupted = saved.status !== "idle" || saved.outcome === "interrupted";
    const status = displayStatus(saved.status, saved.outcome);
    const displayName = getDisplayName(saved.type, this.registry);
    const duration = interrupted
      ? "unknown"
      : formatAgentDuration(saved.startedAt, saved.completedAt ?? saved.startedAt);
    const text = formatSavedAgentReport({
      id: saved.id,
      displayName,
      status,
      interrupted,
      toolUses: saved.toolUses,
      duration,
      description: saved.description,
      result: saved.result,
      error: saved.error,
      turnBudget: saved.turnBudget,
      model: saved.model,
      thinkingLevel: saved.thinkingLevel,
      cwd: saved.cwd,
      transcriptPath: saved.outputFile,
      verbose,
      sendRefusal: this.manager.sendRefusalFor(saved),
    });
    return textResult<GetResultDetails>(text, {
      agentId: saved.id,
      displayName,
      status: interrupted ? "stopped" : status,
      description: saved.description,
      toolUses: saved.toolUses,
      tokens: "",
      contextPercent: null,
      compactionCount: 0,
      duration,
      preview: buildPreview(saved.result),
      error: interrupted ? "Interrupted: the session was reloaded or replaced" : saved.error,
      turnBudget: saved.turnBudget,
      verbose,
      transcriptPath: saved.outputFile,
      modelName: saved.model,
    });
  }

  /** The report on the live record's current outcome. */
  private buildReport(record: Subagent, verbose: boolean): AgentReport {
    return {
      id: record.id,
      displayName: getDisplayName(record.type, this.registry),
      status: record.displayStatus,
      toolUses: record.toolUses,
      tokens: formatLifetimeTokens(record),
      contextPercent: record.getContextPercent(),
      compactionCount: record.compactionCount,
      duration: formatAgentDuration(record.startedAt, record.completedAt),
      description: record.description,
      result: record.result,
      error: record.error,
      turnBudget: record.turnBudget,
      stoppedWhileQueued: record.stoppedWhileQueued,
      waitingOn: record.waitingOn,
      conversation: verbose ? record.getConversation() : undefined,
      // Transcript pointer: lets the parent read the full session from disk,
      // and covers verbose after the live session was released (no conversation).
      transcriptPath: record.outputFile,
      runUpdates: record.runUpdates,
      sendRefusal: record.sendRefusal,
      model: modelLabel(record.model),
    };
  }

  /**
   * The compact metadata the TUI renders from.
   */
  private buildGetResultDetails(record: Subagent, verbose: boolean): GetResultDetails {
    return {
      agentId: record.id,
      displayName: getDisplayName(record.type, this.registry),
      status: record.displayStatus,
      description: record.description,
      toolUses: record.toolUses,
      tokens: formatLifetimeTokens(record),
      contextPercent: record.getContextPercent(),
      compactionCount: record.compactionCount,
      duration: formatAgentDuration(record.startedAt, record.completedAt),
      preview: buildPreview(record.result),
      error: record.error,
      turnBudget: record.turnBudget,
      verbose,
      transcriptPath: record.outputFile,
      modelName: modelLabel(record.model),
    };
  }

  toToolDefinition() {
    return defineTool({
      name: "subagent_get" as const,
      label: "Get Agent Result",
      promptSnippet:
        "Check status and retrieve results from a background agent, or list this branch's agents.",
      description:
        "Check status and read the full result of a background agent without waiting for it. Use the agent ID returned by subagent_start. A running agent reports its status; its completion message arrives when it finishes, so end your turn instead of polling. " +
        "Agents from before a reload, resume or compaction keep their saved result and transcript path, and the report says whether subagent_send can still reach them. " +
        "Without agent_id, lists the agents started on this branch: waiting first, then running, then idle agents whose last run failed or stopped, then completed ones, newest first.",
      parameters: Type.Object({
        agent_id: Type.Optional(
          Type.String({
            description: "The agent ID to check. Omit to list this branch's agents.",
          }),
        ),
        verbose: Type.Optional(
          Type.Boolean({
            description:
              "If true, include the agent's full conversation (messages + tool calls). Default: false.",
          }),
        ),
      }),
      // ---- Custom rendering: a bounded, Ctrl+O-expandable retrieval row ----

      renderCall(args: GetParams, theme: Theme) {
        const notes = args.verbose === true ? "verbose" : "";
        return new Text(
          `${ICONS.tool} ` +
            theme.fg("toolTitle", theme.bold("Get Agent Result")) +
            "  " +
            theme.fg("muted", args.agent_id ?? "list") +
            (notes ? " " + theme.fg("muted", `(${notes})`) : ""),
          0,
          0,
        );
      },

      renderResult(
        result: AgentToolResult<GetResultDetails | GetListDetails | undefined>,
        { expanded }: ToolRenderResultOptions,
        theme: Theme,
      ) {
        const reportText = result.content[0]?.type === "text" ? result.content[0].text : "";
        const details = result.details;
        if (!details) return new Text(reportText, 0, 0);
        if ("kind" in details) {
          const summary = theme.fg(
            "muted",
            `${details.total} agent${details.total === 1 ? "" : "s"} on this branch`,
          );
          const lines = expanded
            ? [
                summary,
                ...reportText
                  .split("\n")
                  .slice(1)
                  .map((line) => theme.fg("dim", line)),
              ]
            : [summary];
          return { render: (width: number) => renderListRows(lines, width), invalidate() {} };
        }
        return new BoundedLines(renderGetResultLines(details, reportText, expanded, theme));
      },

      execute: async (
        toolCallId: string,
        params: GetParams,
        signal: AbortSignal,
        onUpdate: unknown,
        ctx: unknown,
      ): Promise<AgentToolResult<GetResultDetails | GetListDetails | undefined>> => {
        const { agent_id } = params;
        if (agent_id === undefined) return this.list(ctx);
        return this.execute(toolCallId, { ...params, agent_id }, signal, onUpdate, ctx);
      },
    });
  }
}

/**
 * One padded row per list line, each kept to a single terminal row; a width
 * too narrow for the padding renders blank rows.
 */
export function renderListRows(lines: readonly string[], width: number): string[] {
  return lines.map((line) => bodyRow(line, width));
}

/** The first non-empty line of a result body, clipped to the preview budget. */
function buildPreview(result: string | undefined): string | undefined {
  const line = result
    ?.split("\n")
    .find((candidate) => candidate.trim())
    ?.trim();
  if (!line) return undefined;
  return line.length > PREVIEW_CHARS ? line.slice(0, PREVIEW_CHARS - 1) + "\u2026" : line;
}
