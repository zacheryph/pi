import { debugLog } from "#src/debug";
import type { SubagentStatus } from "#src/lifecycle/subagent-state";
import type { TurnBudget } from "#src/lifecycle/turn-limits";
import { getLifetimeTotal } from "#src/lifecycle/usage";
import {
  renderQuestionAffordance,
  renderRunUpdates,
  renderStatusLabel,
} from "#src/observation/outcome-delivery";
import type { Subagent } from "#src/types";

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
  id: string;
  description: string;
  status: SubagentStatus;
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

/** Format a structured <task-notification> XML block for the parent agent to parse. */
export function formatTaskNotification(record: Subagent, resultMaxLen: number): string {
  if (record.stoppedWhileQueued) return formatNeverStartedNotification(record);

  const status = renderStatusLabel(record);
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
    `<summary>Subagent "${escapeXml(record.description)}" ${record.status}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}<duration_ms>${durationMs}</duration_ms></usage>`,
    "</task-notification>",
  ]);
}

/**
 * Format a `<subagent-update>` block for a message a still-running child sent.
 *
 * A distinct element from `<task-notification>`: the child has not finished, so
 * the parent's next action is to steer it or leave it alone, never to collect a
 * result that does not exist yet.
 */
export function formatUpdateNotification(record: Subagent, message: string): string {
  return joinNotificationLines([
    "<subagent-update>",
    `<task-id>${record.id}</task-id>`,
    `<summary>Subagent "${escapeXml(record.description)}" sent an update</summary>`,
    `<message>${escapeXml(message)}</message>`,
    "</subagent-update>",
    `The agent is still running. Steer it with subagent_steer("${record.id}", "...") to redirect it, or let it continue.`,
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
    status: record.status,
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
    status: record.status,
    turnBudget: record.turnBudget,
    toolUses: record.toolUses,
    durationMs,
    tokens,
  };
}

// ---- Notification system factory ----

export interface NotificationSystem {
  sendCompletion: (record: Subagent) => void;
  sendUpdate: (record: Subagent, message: string) => void;
  dispose: () => void;
}

/** Details the update renderer reads. */
export interface UpdateDetails {
  id: string;
  description: string;
  message: string;
}

/**
 * One announcement withheld for the parent's current run.
 *
 * A completion for an agent supersedes an earlier one for that agent; two
 * updates are two distinct facts and both survive.
 */
type PendingAnnouncement =
  | { kind: "completion"; record: Subagent }
  | { kind: "update"; record: Subagent; message: string };

export class NotificationManager implements NotificationSystem {
  // pi.sendMessage is fire-and-forget: while the parent's agent run is active,
  // a followUp is handed to a queue the extension cannot recall, and is only
  // delivered when the run drains that queue at turn end. So announcements that
  // arrive mid-run are withheld here and flushed once the run settles.
  // Ordered rather than record-keyed: a completion for an agent supersedes an
  // earlier one for that agent, but announcements from different agents are
  // distinct facts, and arrival order is the only order the parent can make
  // sense of.
  private pending: PendingAnnouncement[] = [];
  private parentRunActive = false;
  private disposed = false;

  constructor(
    private sendMessage: (
      msg: { customType: string; content: string; display: boolean; details?: unknown },
      opts?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
    ) => void,
  ) {}

  sendCompletion(record: Subagent): void {
    // The session is gone. It is the aborts fired during shutdown that reach
    // here, and with no parent run active a nudge would go straight out as an
    // unrecallable followUp.
    if (this.disposed) return;
    // The completion message is the only carrier of an outcome, so every
    // terminal transition is announced exactly once, whatever the parent has
    // read with subagent_get in the meantime.
    if (this.parentRunActive) {
      this.withholdCompletion(record);
      return;
    }
    this.emitIndividualNudge(record);
  }

  /**
   * Queue a completion for the flush, superseding an earlier one for the same
   * agent in the position that one already holds — a re-completion is the same
   * fact told again, not a later one.
   */
  private withholdCompletion(record: Subagent): void {
    const entry: PendingAnnouncement = { kind: "completion", record };
    const existing = this.pending.findIndex(
      (queued) => queued.kind === "completion" && queued.record.id === record.id,
    );
    if (existing === -1) this.pending.push(entry);
    else this.pending[existing] = entry;
  }

  /**
   * Announce a message a still-running child sent its parent.
   *
   * What is consulted is whether an announcement is still the right channel at
   * all — see `canAnnounceUpdate`. The disposal latch and the parent-run
   * withhold apply as they do to any announcement.
   */
  sendUpdate(record: Subagent, message: string): void {
    if (this.disposed) return;
    if (!this.canAnnounceUpdate(record)) return;
    if (this.parentRunActive) {
      this.pending.push({ kind: "update", record, message });
      return;
    }
    this.emitUpdate(record, message);
  }

  /**
   * Whether an announcement is still the right channel for this run's updates.
   *
   * A terminated run has an outcome, and its completion message renders what the
   * run still owes, so the update arrives with it rather than as a live update
   * the child can no longer act on.
   *
   * Consulted at enqueue and again at emit, because a run withheld for the
   * parent's turn can terminate in between. That re-read is what keeps a
   * `<subagent-update>` block's steering affordance true.
   */
  private canAnnounceUpdate(record: Subagent): boolean {
    return record.isActive();
  }

  /** The parent's agent run became active; announcements are withheld until it settles. */
  onParentAgentStart(): void {
    this.parentRunActive = true;
  }

  /**
   * The parent's agent run settled. Flush the announcements withheld during it.
   */
  onParentAgentSettled(): void {
    this.parentRunActive = false;
    const withheld = this.pending.splice(0);
    for (const entry of withheld) {
      try {
        if (entry.kind === "update") this.emitUpdate(entry.record, entry.message);
        else this.emitIndividualNudge(entry.record);
      } catch (err) {
        debugLog("notification render", err);
      }
    }
  }

  /** Terminal: the manager stops announcing anything, now and afterwards. */
  dispose(): void {
    this.disposed = true;
    this.pending.length = 0;
  }

  private emitUpdate(record: Subagent, message: string): void {
    if (!this.canAnnounceUpdate(record)) return;
    // This channel is delivering the message, so the completion message does not
    // repeat it — the record renders only what is still owed.
    record.markUpdateAnnounced(message);
    const details: UpdateDetails = {
      id: record.id,
      description: record.description,
      message,
    };
    this.sendMessage(
      {
        customType: "subagent:update",
        content: formatUpdateNotification(record, message),
        display: true,
        details,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  private emitIndividualNudge(record: Subagent): void {
    const notification = formatTaskNotification(record, 500);
    // A never-started agent has no transcript and nothing to collect.
    const pointerLines = record.stoppedWhileQueued ? "" : this.buildPointerLines(record);

    this.sendMessage(
      {
        customType: "subagent:completion",
        content: notification + pointerLines,
        display: true,
        details: buildNotificationDetails(record, 500),
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  /**
   * The trailing pointer lines: where the transcript lives, and how to read the
   * full result when the preview above is cut.
   */
  private buildPointerLines(record: Subagent): string {
    const outputFile = record.outputFile;
    const transcriptLine = outputFile ? `\nFull transcript available at: ${outputFile}` : "";
    return (
      // What the child flagged along the way leads: this message carries every
      // update no announcement delivered.
      renderRunUpdates(record.runUpdates) +
      `${transcriptLine}\nCall subagent_get("${record.id}") to collect the full result.` +
      renderQuestionAffordance(record.id, record.pendingQuestion, record.resumeRefusal)
    );
  }
}
