/**
 * get-result-report.ts — Pure report assembly for subagent_get.
 *
 * All functions are stateless: they receive an AgentReport, returning
 * formatted strings. No SDK types, no timers, no side effects.
 * Consumed by GetResultTool.execute in get-result-tool.ts. Mirrors the
 * result-renderer.ts pattern used by the subagent_start tool's TUI renderer.
 */

import type { DisplayStatus, SendRefusal } from "#src/lifecycle/subagent";
import type { TurnBudget } from "#src/lifecycle/turn-limits";
import {
  renderOutcomeAddenda,
  renderOutcomeBody,
  renderQuestionAffordance,
  renderSendUnavailable,
  renderStatusNote,
} from "#src/observation/outcome-delivery";

/** The data a subagent_get report renders from — only what the formatter reads. */
export interface AgentReport {
  id: string;
  displayName: string;
  status: DisplayStatus;
  toolUses: number;
  /** Pre-formatted lifetime token total; "" when zero. */
  tokens: string;
  contextPercent: number | null;
  compactionCount: number;
  /** Pre-formatted duration string. */
  duration: string;
  description: string;
  result: string | undefined;
  error: string | undefined;
  /** The run's turn limit and its use; absent when no limit applied. */
  turnBudget?: TurnBudget;
  /** Whether the agent was stopped before the limiter ever admitted it. */
  stoppedWhileQueued: boolean;
  /** Present only when verbose was requested and a conversation is available. */
  conversation?: string;
  /** Persisted transcript path; rendered as a pointer so the parent can read it directly. */
  transcriptPath?: string;
  /** The updates the agent sent that no announcement delivered. */
  runUpdates?: readonly string[];
  /** The question the agent ended its turn with, when it declared one. */
  pendingQuestion?: string;
  /**
   * Why a message would be refused; undefined when one would be accepted.
   * Required, for the reason `OutcomeAddenda` gives.
   */
  sendRefusal: SendRefusal | undefined;
  /**
   * The model's `provider/id`; undefined while an inherited model is still unknown.
   * Required, so a report builder cannot leave it out by omission.
   */
  model: string | undefined;
}

/** Assemble the stats parts: Tool uses / tokens? / Context? / Compactions? / Duration. */
export function renderStatsParts(report: AgentReport): string[] {
  const parts = [`Tool uses: ${report.toolUses}`];
  if (report.tokens) parts.push(report.tokens);
  if (report.contextPercent !== null) parts.push(`Context: ${Math.round(report.contextPercent)}%`);
  if (report.compactionCount) parts.push(`Compactions: ${report.compactionCount}`);
  parts.push(`Duration: ${report.duration}`);
  return parts;
}

/**
 * Select the per-status body. `AgentReport` structurally satisfies
 * `OutcomeBody`, so this is the shared renderer under this report's name.
 */
export function renderReportBody(report: AgentReport): string {
  return renderOutcomeBody(report);
}

/** Assemble the full subagent_get report text. */
export function formatAgentReport(report: AgentReport): string {
  let output =
    `Agent: ${report.id}\n` +
    `Type: ${report.displayName} | Status: ${report.status}${renderStatusNote(report)} | ${renderStatsParts(report).join(" | ")}\n` +
    (report.model ? `Model: ${report.model}\n` : "") +
    `Description: ${report.description}\n\n`;
  output += renderReportBody(report);
  output += renderOutcomeAddenda(report);
  if (!report.pendingQuestion && report.sendRefusal) {
    const unavailable = renderSendUnavailable(report.sendRefusal);
    if (unavailable) output += `\n\n${unavailable}`;
  }
  if (report.conversation) {
    output += `\n\n--- Agent Conversation ---\n${report.conversation}`;
  }
  if (report.transcriptPath) {
    output += `\n\nFull transcript available at: ${report.transcriptPath}`;
  }
  return output;
}

/**
 * The data a report on a saved record renders from: an agent this branch
 * started whose live record is gone, so only its last `subagent:record` entry
 * speaks for it.
 */
export interface SavedAgentReport {
  id: string;
  displayName: string;
  status: DisplayStatus;
  /** The record still read queued or running, but no live agent backs it. */
  interrupted: boolean;
  toolUses: number;
  duration: string;
  description: string;
  result: string | undefined;
  error: string | undefined;
  turnBudget?: TurnBudget;
  pendingQuestion?: string;
  model: string | undefined;
  thinkingLevel?: string;
  cwd?: string;
  transcriptPath?: string;
  /** The call asked for the conversation, which only a live record holds. */
  verbose: boolean;
  /** Why a message would be refused; undefined when one would be accepted. */
  sendRefusal: SendRefusal | undefined;
}

/** Whether a message would reopen this agent's transcript, as one sentence. */
function renderSavedSendNote(report: SavedAgentReport): string {
  return report.sendRefusal
    ? renderSendUnavailable(report.sendRefusal)
    : `Send: available. Call subagent_send with agent_id: "${report.id}" and your message to ` +
        "reopen its saved transcript and continue where it left off.";
}

/** Assemble the subagent_get report for a saved record. */
export function formatSavedAgentReport(report: SavedAgentReport): string {
  const status = report.interrupted ? "interrupted" : report.status;
  const note = report.interrupted ? "" : renderStatusNote(report);
  let output =
    `Agent: ${report.id}\n` +
    `Type: ${report.displayName} | Status: ${status}${note} | Tool uses: ${report.toolUses} | Duration: ${report.duration}\n` +
    (report.model
      ? `Model: ${report.model}${report.thinkingLevel ? ` (thinking ${report.thinkingLevel})` : ""}\n`
      : "") +
    (report.cwd ? `Directory: ${report.cwd}\n` : "") +
    `Description: ${report.description}\n\n`;
  output += report.interrupted
    ? "This agent was still running when this session was reloaded or replaced, so it never " +
      "finished. Its transcript shows how far it got."
    : renderOutcomeBody({ ...report, stoppedWhileQueued: false });
  output +=
    report.pendingQuestion && report.status === "completed"
      ? renderQuestionAffordance(report.id, report.pendingQuestion, report.sendRefusal)
      : `\n\n${renderSavedSendNote(report)}`;
  if (report.verbose) {
    output += "\n\nThe conversation is not in memory any more; read the transcript instead.";
  }
  if (report.transcriptPath) {
    output += `\n\nFull transcript available at: ${report.transcriptPath}`;
  }
  return output;
}
