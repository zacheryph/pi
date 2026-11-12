import type { DisplayStatus } from "#src/lifecycle/subagent-state";
import type { TurnBudget } from "#src/lifecycle/turn-limits";
import { getLifetimeTotal } from "#src/lifecycle/usage";
import { renderRunUpdates, renderStatusLabel } from "#src/observation/outcome-delivery";
import type { Json, WorkMessage } from "#work";
import type { Subagent } from "#src/types";

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
  id: string;
  description: string;
  status: DisplayStatus;
  toolUses: number;
  totalTokens: number;
  durationMs: number;
  outputFile?: string;
  error?: string;
  resultPreview: string;
  /** The run's turn budget; absent until its turn loop starts. */
  turnBudget?: TurnBudget;
}

// ---- Pure helpers (exported for unit testing) ----

/**
 * Escape XML special characters to prevent injection in structured
 * notifications. Quotes are escaped too, so values stay safe if they are ever
 * placed in attribute position, not only element content.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** What the status labels read of a record: its display status, error and turn budget. */
function statusOutcome(record: Subagent) {
  return { status: record.displayStatus, error: record.error, turnBudget: record.turnBudget };
}

/** Format a structured <task-notification> XML block for the parent agent to parse. */
export function formatTaskNotification(record: Subagent, resultMaxLen: number): string {
  if (record.stoppedWhileQueued) return formatNeverStartedNotification(record);

  const status = renderStatusLabel(statusOutcome(record));
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const contextPercent = record.getContextPercent();
  const ctxXml =
    contextPercent !== null
      ? `<context_percent>${Math.round(contextPercent)}</context_percent>`
      : "";
  const compactXml = record.compactionCount
    ? `<compactions>${record.compactionCount}</compactions>`
    : "";

  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) + "\n...(truncated, use subagent_get for full output)"
      : record.result
    : "No output.";

  const toolCallId = record.toolCallId;
  const outputFile = record.outputFile;
  return joinNotificationLines([
    "<task-notification>",
    `<task-id>${record.id}</task-id>`,
    toolCallId ? `<tool-use-id>${escapeXml(toolCallId)}</tool-use-id>` : null,
    outputFile ? `<output-file>${escapeXml(outputFile)}</output-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Subagent "${escapeXml(record.description)}" ${record.displayStatus}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}<duration_ms>${durationMs}</duration_ms></usage>`,
    "</task-notification>",
  ]);
}

/**
 * Format a `<subagent-update>` block for a message a still-running child sent.
 *
 * A distinct element from `<task-notification>`: the child has not finished, so
 * the parent's next action is to message it or leave it alone, never to collect a
 * result that does not exist yet.
 */
export function formatUpdateNotification(record: Subagent, message: string): string {
  return joinNotificationLines([
    "<subagent-update>",
    `<task-id>${record.id}</task-id>`,
    `<summary>Subagent "${escapeXml(record.description)}" sent an update</summary>`,
    `<message>${escapeXml(message)}</message>`,
    "</subagent-update>",
    `The agent is still running. Message it with subagent_send("${record.id}", "...") to redirect it, or let it continue.`,
  ]);
}

/**
 * Format a `<subagent-question>` block for a question a child asked its parent.
 *
 * The child is not running and not done: it waits on the answer, and the parent's next action
 * is the exact `subagent_send` call that answers it. The question is delivered once, here; no
 * later message repeats it.
 */
export function formatQuestionNotification(record: Subagent, question: string): string {
  return joinNotificationLines([
    "<subagent-question>",
    `<task-id>${record.id}</task-id>`,
    `<summary>Subagent "${escapeXml(record.description)}" asked a question and is waiting for your answer</summary>`,
    `<question>${escapeXml(question)}</question>`,
    "</subagent-question>",
    `Answer by calling subagent_send with agent_id: "${record.id}" and your answer as the message. The agent resumes with your message as its next prompt.`,
  ]);
}

/**
 * Format the block for an agent stopped before the limiter admitted it. Such an
 * agent never ran, so it has no result and no usage — reporting either (even as
 * zeroes) would point the parent at work that does not exist.
 */
function formatNeverStartedNotification(record: Subagent): string {
  const toolCallId = record.toolCallId;
  return joinNotificationLines([
    "<task-notification>",
    `<task-id>${record.id}</task-id>`,
    toolCallId ? `<tool-use-id>${escapeXml(toolCallId)}</tool-use-id>` : null,
    "<status>Stopped before starting</status>",
    `<summary>Subagent "${escapeXml(record.description)}" was stopped while queued and never started</summary>`,
    "</task-notification>",
  ]);
}

/** Join notification lines, dropping the ones a conditional element omitted. */
function joinNotificationLines(lines: (string | null)[]): string {
  return lines.filter(Boolean).join("\n");
}

/** Build notification details for the custom message renderer. */
export function buildNotificationDetails(
  record: Subagent,
  resultMaxLen: number,
): NotificationDetails {
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);

  return {
    id: record.id,
    description: record.description,
    status: record.displayStatus,
    toolUses: record.toolUses,
    totalTokens,
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    outputFile: record.outputFile,
    error: record.error,
    resultPreview: buildResultPreview(record, resultMaxLen),
    turnBudget: record.turnBudget,
  };
}

/** The renderer's preview text: the (truncated) result, or why there is none. */
function buildResultPreview(record: Subagent, resultMaxLen: number): string {
  if (record.stoppedWhileQueued) return "Never started — stopped while queued.";
  if (!record.result) return "No output.";
  return record.result.length > resultMaxLen
    ? record.result.slice(0, resultMaxLen) + "…"
    : record.result;
}

/** Build event data for lifecycle events from a Subagent. */
export function buildEventData(record: Subagent) {
  const durationMs = record.completedAt
    ? record.completedAt - record.startedAt
    : Date.now() - record.startedAt;
  const u = record.lifetimeUsage;
  const total = getLifetimeTotal(u);
  const tokens = total > 0 ? { input: u.input, output: u.output, total } : undefined;
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    result: record.result,
    error: record.error,
    status: record.displayStatus,
    turnBudget: record.turnBudget,
    toolUses: record.toolUses,
    durationMs,
    tokens,
  };
}

// ---- The messages a spawner's work item delivers ----

/** The most characters of a result the completion message carries. */
export const RESULT_PREVIEW_LENGTH = 500;

/** Custom message types the parent's transcript holds, and the renderers are registered for. */
export const COMPLETION_TYPE = "subagent:completion";
export const UPDATE_TYPE = "subagent:update";
export const QUESTION_TYPE = "subagent:question";

/** Details the update renderer reads. */
export interface UpdateDetails {
  id: string;
  description: string;
  message: string;
}

/** Details the question renderer reads. */
export interface QuestionDetails {
  id: string;
  description: string;
  question: string;
}

/**
 * The trailing pointer lines: where the transcript lives, and how to read the
 * full result when the preview above is cut.
 */
function buildPointerLines(record: Subagent): string {
  const outputFile = record.outputFile;
  const transcriptLine = outputFile ? `\nFull transcript available at: ${outputFile}` : "";
  return (
    // What the child flagged along the way leads: this message carries every
    // update no announcement delivered.
    renderRunUpdates(record.runUpdates) +
    `${transcriptLine}\nCall subagent_get("${record.id}") to collect the full result.`
  );
}

/**
 * The message that tells the parent a run ended, whatever the outcome. The
 * completion message is the only carrier of an outcome, so every run's end
 * is announced with one of these.
 */
export function completionMessage(record: Subagent): WorkMessage {
  const notification = formatTaskNotification(record, RESULT_PREVIEW_LENGTH);
  // A never-started agent has no transcript and nothing to collect.
  const pointerLines = record.stoppedWhileQueued ? "" : buildPointerLines(record);
  return {
    customType: COMPLETION_TYPE,
    content: notification + pointerLines,
    details: buildNotificationDetails(record, RESULT_PREVIEW_LENGTH) as unknown as Json,
  };
}

/**
 * The message that tells the parent a child asked it a question. Delivered through the agent's
 * item when pi-ask opens the child's question item.
 */
export function questionMessage(record: Subagent, question: string): WorkMessage {
  const details: QuestionDetails = { id: record.id, description: record.description, question };
  return {
    customType: QUESTION_TYPE,
    content: formatQuestionNotification(record, question),
    details: details as unknown as Json,
  };
}

/** The message that tells the parent a still-running child sent it an update. */
export function updateMessage(record: Subagent, message: string): WorkMessage {
  const details: UpdateDetails = { id: record.id, description: record.description, message };
  return {
    customType: UPDATE_TYPE,
    content: formatUpdateNotification(record, message),
    details: details as unknown as Json,
  };
}
