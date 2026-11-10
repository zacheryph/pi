/**
 * subagent-state.ts — SubagentState value object: lifecycle status, metrics, and live activity.
 *
 * Owns the passive, readable state of a subagent — status, result, error,
 * timestamps, stats (toolUses, lifetimeUsage, compactionCount), and live-activity
 * fields (activeTools, responseText) and the live turn budget — together with the transition
 * methods (markRunning, markCompleted, …), accumulation methods
 * (incrementToolUses, addUsage, incrementCompactions), and live-activity
 * transition methods (setTurnBudget, addActiveTool, removeActiveTool,
 * resetResponseText, appendResponseText) that mutate them.
 *
 * State is encapsulated behind getters; external code reads through them but
 * mutates only via the transition/accumulation methods. The value object owns
 * all of its own mutations — no field is written from outside.
 *
 * Subagent holds one of these privately and delegates its getters and mutation
 * methods to it. Extracting it lets the lifecycle state machine and the
 * session-event observer be unit-tested without constructing an executor.
 */

import type { TurnBudget } from "#src/lifecycle/turn-limits";
import type { LifetimeUsage } from "#src/lifecycle/usage";
import { addUsage } from "#src/lifecycle/usage";

/**
 * Where an agent stands. `queued` is a run waiting for a concurrency slot, the
 * first run or a later one alike; `running` is a run in flight; `idle` is no
 * run at all, whatever the last one produced (see `RunOutcome`).
 */
export type SubagentStatus = "queued" | "running" | "idle";

/**
 * How the last run ended. Stored beside the status of an idle agent, and
 * undefined while a run is queued or running.
 *
 * `turn-limit` is the harness ending a run at its turn limit, and `interrupted`
 * a run that a reload or restart cut short: a record read back from storage
 * that still said queued or running.
 */
export type RunOutcome = "completed" | "turn-limit" | "error" | "stopped" | "interrupted";

/**
 * The six-word vocabulary users and subscribers have always seen for an agent:
 * tool output, the widget, the completion message and the lifecycle events say
 * `completed`, `aborted`, `stopped` or `error`, not "idle with an outcome".
 * Derived from status and outcome by `displayStatus`, and kept as the
 * wire/label vocabulary until the idle/done presentation replaces it.
 */
export type DisplayStatus = "queued" | "running" | "completed" | "aborted" | "stopped" | "error";

/**
 * The label for a status and the outcome beside it. An interrupted run reads as
 * `stopped`, as it always has once its record is rebuilt after a reload.
 */
export function displayStatus(
  status: SubagentStatus,
  outcome: RunOutcome | undefined,
): DisplayStatus {
  if (status !== "idle") return status;
  switch (outcome) {
    case "completed":
      return "completed";
    case "turn-limit":
      return "aborted";
    case "error":
      return "error";
    case "stopped":
    case "interrupted":
    case undefined:
      return "stopped";
  }
}

// ---- Status classification predicates ----
// The single decision point for the re-derived status groupings. Instance
// methods on SubagentState delegate here; DTO consumers holding a bare status
// or display label (no SubagentState instance) call these directly.

/** Running or queued — the agent has a run in flight or waiting for a slot. */
export function isActiveStatus(status: SubagentStatus | DisplayStatus): boolean {
  return status === "running" || status === "queued";
}

/** A display label for a run that ended in error, harness turn-limit abort, or a stop. */
export function isTerminalErrorStatus(status: SubagentStatus | DisplayStatus): boolean {
  return status === "error" || status === "stopped" || status === "aborted";
}

/** A run that did not end in `completed`. */
export function isFailureOutcome(outcome: RunOutcome | undefined): boolean {
  return outcome !== undefined && outcome !== "completed";
}

/** Actively running (excludes queued). */
export function isRunningStatus(status: SubagentStatus | DisplayStatus): boolean {
  return status === "running";
}

/** One update a child sent during a run, and whether an announcement delivered it. */
interface RunUpdate {
  message: string;
  announced: boolean;
}

export interface SubagentStateInit {
  status?: SubagentStatus;
  /**
   * How the last run ended. Read only for an idle agent, where it defaults to
   * `completed`: an idle agent has always finished a run.
   */
  outcome?: RunOutcome;
  result?: string;
  /** The run's turn limit and its use — an outcome fact, like result. */
  turnBudget?: TurnBudget;
  error?: string;
  /** Whether the agent was stopped before the limiter ever admitted it. */
  stoppedWhileQueued?: boolean;
  startedAt?: number;
  completedAt?: number;
  /** Time the parent read the finished result with `subagent_get`; undefined = not read. */
  consumedAt?: number;
  // Stats — seed a populated value without replaying the accumulation methods
  toolUses?: number;
  lifetimeUsage?: LifetimeUsage;
  compactionCount?: number;
  // Live activity — activeTools is seeded by name (each entry calls addActiveTool)
  activeTools?: string[];
  responseText?: string;
}

export class SubagentState {
  // Transition state — encapsulated behind getters, mutated only via transition methods
  private _status: SubagentStatus;
  get status(): SubagentStatus {
    return this._status;
  }

  // How the last run ended; defined exactly while the agent is idle.
  private _outcome?: RunOutcome;
  get outcome(): RunOutcome | undefined {
    return this._outcome;
  }

  /** The label users see for this status and outcome. */
  get displayStatus(): DisplayStatus {
    return displayStatus(this._status, this._outcome);
  }

  private _result?: string;
  get result(): string | undefined {
    return this._result;
  }

  private _error?: string;
  get error(): string | undefined {
    return this._error;
  }

  // Never-started marker — a queued agent stopped before its slot opened has no
  // result, as distinct from a started agent that produced none.
  private _stoppedWhileQueued: boolean;
  get stoppedWhileQueued(): boolean {
    return this._stoppedWhileQueued;
  }

  private _startedAt: number;
  get startedAt(): number {
    return this._startedAt;
  }

  private _completedAt?: number;
  get completedAt(): number | undefined {
    return this._completedAt;
  }

  // Whether the parent has read the finished result with `subagent_get`
  // (orthogonal to status). It decides only how long the session is retained;
  // it never decides whether the completion message is sent.
  private _consumedAt?: number;
  get consumedAt(): number | undefined {
    return this._consumedAt;
  }
  get consumed(): boolean {
    return this._consumedAt != null;
  }

  // The run's turn budget, live: the turn loop reports it before the first turn
  // and after each boundary, so the last report is already the outcome's. Part
  // of the outcome like _result, and cleared where a run begins (markQueued).
  private _turnBudget?: TurnBudget;
  get turnBudget(): TurnBudget | undefined {
    return this._turnBudget;
  }

  // The updates the child sent during this run, each remembering whether it was
  // announced as it happened — so a message reaches the parent once: the
  // completion message repeats only the updates no announcement delivered.
  // Scoped to the run, so it clears wherever a run begins.
  // Transient runtime state, so deliberately not seedable via SubagentStateInit
  // — a rehydrated record has no run to have produced these.
  private _runUpdates: RunUpdate[] = [];
  /** The updates no announcement delivered — what the completion message must render. */
  get runUpdates(): readonly string[] {
    return this._runUpdates.filter((update) => !update.announced).map((update) => update.message);
  }

  // Stats — accumulated via mutation methods, readable via getters
  private _toolUses: number;
  get toolUses(): number {
    return this._toolUses;
  }

  private _lifetimeUsage: LifetimeUsage;
  get lifetimeUsage(): Readonly<LifetimeUsage> {
    return this._lifetimeUsage;
  }

  private _compactionCount: number;
  get compactionCount(): number {
    return this._compactionCount;
  }

  // Live activity — accumulated via transition methods, readable via getters
  private _activeTools = new Map<string, string>();
  get activeTools(): ReadonlyMap<string, string> {
    return this._activeTools;
  }

  private _toolKeySeq = 0;

  private _responseText: string;
  get responseText(): string {
    return this._responseText;
  }

  constructor(init: SubagentStateInit = {}) {
    this._status = init.status ?? "queued";
    this._outcome = this._status === "idle" ? (init.outcome ?? "completed") : undefined;
    this._result = init.result;
    this._turnBudget = init.turnBudget;
    this._error = init.error;
    this._stoppedWhileQueued = init.stoppedWhileQueued ?? false;
    this._startedAt = init.startedAt ?? Date.now();
    this._completedAt = init.completedAt;
    this._consumedAt = init.consumedAt;
    this._toolUses = init.toolUses ?? 0;
    // Copy so a later addUsage() cannot mutate the caller's object.
    this._lifetimeUsage = init.lifetimeUsage
      ? { ...init.lifetimeUsage }
      : { input: 0, output: 0, cacheWrite: 0 };
    this._compactionCount = init.compactionCount ?? 0;
    this._responseText = init.responseText ?? "";
    for (const name of init.activeTools ?? []) {
      this.addActiveTool(name);
    }
  }

  /** Running or queued — a run is in flight or waiting for a slot. */
  isActive(): boolean {
    return isActiveStatus(this._status);
  }

  /** The last run ended in error, at the harness turn limit, by a stop or by an interruption. */
  isTerminalError(): boolean {
    return isFailureOutcome(this._outcome);
  }

  /** Actively running (excludes queued). */
  isRunning(): boolean {
    return isRunningStatus(this._status);
  }

  /** Whether a steer message can be delivered — the agent must be running. */
  canBeSteered(): boolean {
    return isRunningStatus(this._status);
  }

  /** Increment tool use count. Called by record-observer on tool_execution_end. */
  incrementToolUses(): void {
    this._toolUses++;
  }

  /** Accumulate a usage delta into lifetimeUsage. Called by record-observer on message_end. */
  addUsage(delta: { input: number; output: number; cacheWrite: number }): void {
    addUsage(this._lifetimeUsage, delta);
  }

  /** Increment compaction count. Called by record-observer on compaction_end. */
  incrementCompactions(): void {
    this._compactionCount++;
  }

  /** Record a tool starting. Called by record-observer on tool_execution_start. */
  addActiveTool(toolName: string): void {
    this._activeTools.set(toolName + "_" + ++this._toolKeySeq, toolName);
  }

  /** Remove one active tool by name (first match). Called by record-observer on tool_execution_end. */
  removeActiveTool(toolName: string): void {
    for (const [key, name] of this._activeTools) {
      if (name === toolName) {
        this._activeTools.delete(key);
        break;
      }
    }
  }

  /** Reset the current response text. Called by record-observer on message_start. */
  resetResponseText(): void {
    this._responseText = "";
  }

  /** Append a text delta to the current response text. Called by record-observer on message_update. */
  appendResponseText(delta: string): void {
    this._responseText += delta;
  }

  /** A run begins. Sets status and startedAt; the previous outcome no longer applies. */
  markRunning(startedAt: number): void {
    this._status = "running";
    this._outcome = undefined;
    this._startedAt = startedAt;
    this._runUpdates.length = 0;
  }

  /**
   * A later run asks for a slot: queued again, and the run it replaces is
   * forgotten. Everything a finished run left on the record (its result, error,
   * question, turn budget, read time and end time) belongs to that run, so it
   * clears here, and the record reads like a first run waiting for its slot.
   */
  markQueued(startedAt: number): void {
    this._status = "queued";
    this._outcome = undefined;
    this._stoppedWhileQueued = false;
    this._startedAt = startedAt;
    this._completedAt = undefined;
    this._result = undefined;
    this._error = undefined;
    this._consumedAt = undefined;
    this._turnBudget = undefined;
    this._runUpdates.length = 0;
  }

  /** Record the budget the running turn loop reports. */
  setTurnBudget(budget: TurnBudget): void {
    this._turnBudget = budget;
  }

  /** Record an update the child sent during this run, owed to a carrier until delivered. */
  recordUpdate(message: string): void {
    this._runUpdates.push({ message, announced: false });
  }

  /**
   * The announcement channel delivered this message, so no outcome carrier may
   * repeat it. Marks the first copy still owed: two identical messages are two
   * facts the child sent twice, and one announcement delivered one of them.
   */
  markUpdateAnnounced(message: string): void {
    const owed = this._runUpdates.find((update) => !update.announced && update.message === message);
    if (owed) owed.announced = true;
  }

  /**
   * The run ended: idle, with how it ended. Always sets completedAt (??=). A
   * stop already ended the run and left the agent idle, so a run winding down
   * after one keeps the outcome `stopped`.
   */
  private endRun(outcome: RunOutcome, completedAt?: number): void {
    this._completedAt ??= completedAt ?? Date.now();
    if (this._status === "idle") return;
    this._status = "idle";
    this._outcome = outcome;
  }

  /**
   * The agent finished with no run: it went idle on open work, and the work ran out. Its end
   * time is now, not the time its last run settled, since the wait is part of the assignment.
   */
  markFinishedWithoutRun(completedAt?: number): void {
    this._completedAt = completedAt ?? Date.now();
    // A read made while it was still waiting was of an unfinished result.
    this._consumedAt = undefined;
  }

  /** The run finished. Always sets result; the outcome is `completed` unless a stop came first. */
  markCompleted(result: string, completedAt?: number): void {
    this._result = result;
    this.endRun("completed", completedAt);
  }

  /** The harness ended the run at its turn limit. Always sets result. */
  markTurnLimit(result: string, completedAt?: number): void {
    this._result = result;
    this.endRun("turn-limit", completedAt);
  }

  /** The run failed. Always sets error (formatted). */
  markError(error: unknown, completedAt?: number): void {
    this._error = error instanceof Error ? error.message : String(error);
    this.endRun("error", completedAt);
  }

  /**
   * Record the parent read the finished result. Idempotent — keeps the first
   * read time (??=), so a re-read does not advance the retention clock.
   */
  markConsumed(at?: number): void {
    this._consumedAt ??= at ?? Date.now();
  }

  /** Stop the run: idle with outcome `stopped`. Always valid — no guard. */
  markStopped(completedAt?: number): void {
    this._status = "idle";
    this._outcome = "stopped";
    this._completedAt = completedAt ?? Date.now();
  }

  /**
   * Stop an agent that is still awaiting a concurrency slot. Records the
   * never-started fact only when the agent is genuinely still queued, so a
   * mis-targeted call cannot claim it.
   */
  stopQueued(completedAt?: number): void {
    if (this._status === "queued") this._stoppedWhileQueued = true;
    this.markStopped(completedAt);
  }
}
