import type { SubagentManagerObserver } from "#src/lifecycle/subagent-manager";
import { buildEventData, type NotificationSystem } from "#src/observation/notification";
import {
  type PersistedSubagentRecord,
  SUBAGENT_RECORD_ENTRY,
  toPersistedRecord,
} from "#src/persisted-record";
import type { CompactionInfo, Subagent } from "#src/types";

/** Emit callback — a subset of `pi.events.emit`. */
export type EventEmit = (channel: string, data: unknown) => void;

/** Append callback — a subset of `pi.appendEntry`. */
export type AppendEntry = (customType: string, data: unknown) => void;

export interface SubagentEventsObserverDeps {
  emit: EventEmit;
  appendEntry: AppendEntry;
  notifications: NotificationSystem;
  /** Whether the current branch already contains this agent's initial record. */
  isOnBranch?: (id: string) => boolean;
}

/**
 * Receives agent lifecycle notifications from SubagentManager and dispatches
 * them to three concerns: pi.events lifecycle events, session-entry persistence,
 * and completion notifications.
 *
 * Constructed with narrow deps (emit, appendEntry, NotificationSystem) so all
 * three concerns are unit-testable without booting the extension.
 */
export class SubagentEventsObserver implements SubagentManagerObserver {
  private readonly emit: EventEmit;
  private readonly appendEntry: AppendEntry;
  private readonly notifications: NotificationSystem;
  private readonly isOnBranch: (id: string) => boolean;
  private readonly recorded = new Set<string>();
  private readonly pending = new Map<string, PersistedSubagentRecord>();

  constructor(deps: SubagentEventsObserverDeps) {
    this.emit = deps.emit;
    this.appendEntry = deps.appendEntry;
    this.notifications = deps.notifications;
    this.isOnBranch = deps.isOnBranch ?? (() => true);
  }

  onSubagentWaiting(record: Subagent): void {
    this.emit("subagent:waiting", {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: record.waitingReason,
    });
    this.persist(record);
    // This is an open assignment, not a completion. Let the parent supply guidance.
    if (!record.claimed && record.awaitingGuidance)
      this.notifications.sendUpdate(
        record,
        `Waiting: ${record.waitingReason}. Use subagent_steer to provide guidance.`,
      );
  }

  onSubagentQueued(record: Subagent): void {
    this.emit("subagent:queued", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
    this.persist(record);
  }

  onSubagentStarted(record: Subagent): void {
    // Emit started event when agent transitions to running (including from queue).
    this.emit("subagent:started", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
    this.persist(record);
  }

  onSubagentCompleted(record: Subagent): void {
    // Emit lifecycle event based on terminal status.
    const isError = record.isTerminalError();
    const eventData = buildEventData(record);
    if (isError) {
      this.emit("subagent:failed", eventData);
    } else {
      this.emit("subagent:completed", eventData);
    }

    this.persistAndNotify(record);
  }

  /** The transcript, inherited model and cwd are known before the first prompt. */
  onSubagentSessionCreated(record: Subagent): void {
    this.persist(record);
  }

  /** Apply deferred updates when /tree returns to a branch that contains the agent. */
  refreshBranch(): void {
    for (const [id, record] of this.pending) {
      if (!this.isOnBranch(id)) continue;
      this.appendEntry(SUBAGENT_RECORD_ENTRY, record);
      this.pending.delete(id);
    }
  }

  /**
   * A settled agent went back to running. Announced on its own channel:
   * `subagent:started` reports the first run, and a consumer counting it once
   * per agent must not see it twice. Persisted, so the branch's latest record
   * says the agent is running again and no longer waiting on its question.
   */
  onSubagentResuming(record: Subagent): void {
    this.emit("subagent:resuming", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
    this.persist(record);
  }

  onSubagentResumed(record: Subagent): void {
    // A resumed run terminates in any terminal status; a single distinct
    // channel carries them all — the payload's status/error discriminate. Existing
    // subagent:completed/failed subscribers keep their once-per-run semantics.
    this.emit("subagent:resumed", buildEventData(record));
    this.persistAndNotify(record);
  }

  /**
   * Append the record's current lifecycle step to the parent session. Every
   * step is appended, from the first queued or running one to each terminal
   * one, so a reader folding the branch sees the latest state of every agent
   * this session started, after a reload or resume as much as before it.
   */
  private persist(record: Subagent): void {
    const data = toPersistedRecord(record);
    // Only the first lifecycle entry admits an ID to the branch. Later events
    // can arrive after /tree has left it; keep their latest data until it returns.
    if (this.recorded.has(record.id) && !this.isOnBranch(record.id)) {
      this.pending.set(record.id, data);
      return;
    }
    this.appendEntry(SUBAGENT_RECORD_ENTRY, data);
    this.recorded.add(record.id);
    this.pending.delete(record.id);
  }

  /**
   * Persist the terminal record for cross-extension history reconstruction and
   * announce completion. Shared by every terminal-state handler (fresh and
   * resumed). Whether a nudge is actually owed is the notification manager's
   * decision — it suppresses itself when a carrier has claimed the outcome or
   * the parent has already consumed it. Both are domain state on the record,
   * not owned here.
   */
  private persistAndNotify(record: Subagent): void {
    this.persist(record);
    this.notifications.sendCompletion(record);
  }

  /**
   * A still-running child sent its parent a message. Announced, never
   * persisted: the session entry records lifecycle steps, and a message
   * mid-run is not one.
   */
  onSubagentUpdate(record: Subagent, message: string): void {
    this.emit("subagent:notified", {
      id: record.id,
      type: record.type,
      description: record.description,
      message,
    });
    this.notifications.sendUpdate(record, message);
  }

  onSubagentCompacted(record: Subagent, info: CompactionInfo): void {
    // Emit compacted event when agent's session compacts (preserves count on record).
    this.emit("subagent:compacted", {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  }

  onSubagentCreated(record: Subagent): void {
    // Emit created event for background agents (before limiter admission).
    this.emit("subagent:created", {
      id: record.id,
      type: record.type,
      description: record.description,
      isBackground: record.isBackground,
    });
    // A queued agent belongs to this branch before it gets a slot.
    this.persist(record);
  }
}
