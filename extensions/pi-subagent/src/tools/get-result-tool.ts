import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentConfigLookup } from "#src/config/agent-types";
import type { ReopenSource } from "#src/lifecycle/cold-resume";
import type { ResumeRefusal } from "#src/lifecycle/subagent";
import type { SettledOutcome } from "#src/lifecycle/subagent-state";
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
import { formatDuration, getDisplayName, modelLabel, type Theme } from "#src/ui/display";
import { BoundedLines, bodyRow, ICONS } from "../../../../packages/pi-ui/src/index.ts";

// ---- Deps interfaces ----

export interface GetResultToolManager {
  getRecord(id: string): Subagent | undefined;
  listAgents(): Subagent[];
  /** The check `resume` itself makes, so this report cannot promise what it refuses. */
  resumeRefusalFor(source: { id: string } & ReopenSource): ResumeRefusal | undefined;
}

/** What a `subagent_get` list result carries for the TUI and the roster card's stop rule. */
export interface GetListDetails {
  kind: typeof SUBAGENT_LIST_KIND;
  total: number;
}

type GetParams = { agent_id?: string; wait?: boolean; verbose?: boolean };

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
    signal: AbortSignal,
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

    // Wait for completion if requested. The record owns the decision of whether
    // it is still awaitable — a queued agent counts, because scheduleVia()
    // captures its limiter promise at spawn. A parent interrupt ends the wait
    // without cancelling the agent, leaving the outcome uncollected below.
    //
    // Pull-delivery edge: the parent is collecting the settled outcome here, so
    // mark it consumed. A wait whose run has not settled was abandoned, so it
    // releases the claim it made and lets the nudge announce. The handle drops
    // only this call's claim, so a concurrent carrier's (such as a resume that
    // started as the run settled) is never cleared by this call.
    //
    // A resume that replaced the waited run after it settled leaves this call
    // the only carrier of what that run ended with: its nudge was suppressed by
    // this call's claim. So the report carries that outcome, not the live run's.
    // Consumption is record-wide and now belongs to the resumed run, so it is
    // not marked here; doing so would silence a background resume's nudge.
    let superseded: SettledOutcome | undefined;
    if (params.wait === true) {
      // Waiting commits this call to delivering the outcome, so claim it before
      // the agent can settle and be announced by the nudge instead.
      const claim = record.claim();
      const wait = await record.waitUntilSettled(signal);
      if (wait.kind === "settled") record.markConsumed();
      else claim.release();
      if (wait.kind === "superseded") superseded = wait.outcome;
    } else if (!record.isActive()) {
      record.markConsumed();
    }

    const verbose = params.verbose === true;
    const outcome = superseded ? withoutQuestion(superseded) : liveOutcome(record);
    return textResult<GetResultDetails>(
      formatAgentReport(this.buildReport(record, outcome, verbose, superseded !== undefined)),
      this.buildGetResultDetails(record, outcome, verbose),
    );
  }

  /** List the branch's agents, with live state wherever a live agent backs one. */
  list(ctx: unknown) {
    const branch = readBranchRecords(ctx);
    const getLive = (id: string) => this.manager.getRecord(id);
    const entries = buildRoster(
      branch ?? this.manager.listAgents(),
      getLive,
      (source) => this.manager.resumeRefusalFor(source) === undefined,
    );
    return textResult<GetListDetails>(formatRosterList(entries), {
      kind: SUBAGENT_LIST_KIND,
      total: entries.length,
    });
  }

  /** Answer from the branch's last record for an agent no live record backs. */
  private savedResult(saved: PersistedSubagentRecord, verbose: boolean) {
    const interrupted =
      saved.status === "queued" || saved.status === "running" || saved.status === "waiting";
    const displayName = getDisplayName(saved.type, this.registry);
    const duration = interrupted
      ? "unknown"
      : formatDuration(saved.startedAt, saved.completedAt ?? saved.startedAt);
    const text = formatSavedAgentReport({
      id: saved.id,
      displayName,
      status: saved.status,
      interrupted,
      toolUses: saved.toolUses,
      duration,
      description: saved.description,
      result: saved.result,
      error: saved.error,
      turnBudget: saved.turnBudget,
      pendingQuestion: saved.pendingQuestion,
      model: saved.model,
      thinkingLevel: saved.thinkingLevel,
      cwd: saved.cwd,
      transcriptPath: saved.outputFile,
      verbose,
      resumeRefusal: this.manager.resumeRefusalFor(saved),
    });
    return textResult<GetResultDetails>(text, {
      agentId: saved.id,
      displayName,
      status: interrupted ? "stopped" : saved.status,
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

  /** The report: outcome fields from `outcome`, everything else from the live record. */
  private buildReport(
    record: Subagent,
    outcome: SettledOutcome,
    verbose: boolean,
    resumedWhileWaiting: boolean,
  ): AgentReport {
    return {
      id: record.id,
      displayName: getDisplayName(record.type, this.registry),
      status: outcome.status,
      toolUses: record.toolUses,
      tokens: formatLifetimeTokens(record),
      contextPercent: record.getContextPercent(),
      compactionCount: record.compactionCount,
      duration: formatDuration(outcome.startedAt, outcome.completedAt),
      description: record.description,
      waitingReason: record.waitingReason,
      result: outcome.result,
      error: outcome.error,
      turnBudget: outcome.turnBudget,
      stoppedWhileQueued: record.stoppedWhileQueued,
      conversation: verbose ? record.getConversation() : undefined,
      // Transcript pointer: lets the parent read the full session from disk,
      // and covers verbose after the live session was released (no conversation).
      transcriptPath: record.outputFile,
      runUpdates: outcome.runUpdates,
      pendingQuestion: outcome.pendingQuestion,
      resumeRefusal: record.resumeRefusal,
      model: modelLabel(record.model),
      resumedWhileWaiting,
    };
  }

  /**
   * The compact metadata the TUI renders from.
   *
   * Named in full because `helpers.ts` exports a module-level `buildDetails`
   * producing the structurally different `AgentDetails`.
   */
  private buildGetResultDetails(
    record: Subagent,
    outcome: SettledOutcome,
    verbose: boolean,
  ): GetResultDetails {
    return {
      agentId: record.id,
      displayName: getDisplayName(record.type, this.registry),
      status: outcome.status,
      description: record.description,
      waitingReason: record.waitingReason,
      toolUses: record.toolUses,
      tokens: formatLifetimeTokens(record),
      contextPercent: record.getContextPercent(),
      compactionCount: record.compactionCount,
      duration: formatDuration(outcome.startedAt, outcome.completedAt),
      preview: buildPreview(outcome.result),
      error: outcome.error,
      turnBudget: outcome.turnBudget,
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
        "Check status and retrieve results from a background agent. Use the agent ID returned by subagent_start. " +
        "Agents from before a reload, resume or compaction keep their saved result, question and transcript path, and the report says whether they can still be resumed. " +
        "Without agent_id, lists the agents started on this branch: waiting on a question first, then running, failed, and completed newest first.",
      parameters: Type.Object({
        agent_id: Type.Optional(
          Type.String({
            description: "The agent ID to check. Omit to list this branch's agents.",
          }),
        ),
        wait: Type.Optional(
          Type.Boolean({
            description:
              "If true, block until the agent completes, which also keeps the user waiting. Prefer ending your turn: the completion notification wakes you. Default: false.",
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
        const notes = [args.wait === true ? "waiting" : "", args.verbose === true ? "verbose" : ""]
          .filter(Boolean)
          .join(", ");
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

/** The live record's current outcome fields. */
function liveOutcome(record: Subagent): SettledOutcome {
  return {
    status: record.status,
    result: record.result,
    error: record.error,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    pendingQuestion: record.pendingQuestion,
    runUpdates: record.runUpdates,
    turnBudget: record.turnBudget,
  };
}

/**
 * A superseded run's outcome without its question: the resume that replaced it
 * is that question's answer, and the live record's refusal (still running)
 * would tell the parent to wait and answer it again.
 */
function withoutQuestion(outcome: SettledOutcome): SettledOutcome {
  return { ...outcome, pendingQuestion: undefined };
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
