/**
 * service.ts — Public API surface for cross-extension access to subagents.
 *
 * Consumers declare this package as an optional peer dependency and use
 * dynamic import to access the accessor functions:
 *
 *   const { getSubagentsService } = await import("@gotgenes/pi-subagents");
 *   const svc = getSubagentsService();
 *   svc?.spawn("Explore", "Check for stale TODOs");
 */

import type { ResumeRefusal, SubagentStatus } from "#src/lifecycle/subagent";
import type { ResumeRefusalReason } from "#src/lifecycle/subagent-manager";
import type { TurnBudget } from "#src/lifecycle/turn-limits";
import type { LifetimeUsage } from "#src/lifecycle/usage";
import type {
  Workspace,
  WorkspaceDisposeOutcome,
  WorkspaceDisposeResult,
  WorkspacePrepareContext,
  WorkspaceProvider,
} from "#src/lifecycle/workspace";


// SubagentStatus is defined in the lifecycle layer (single home) and re-exported
// here for the public API surface — mirrors the LifetimeUsage / workspace pattern.
export type { SubagentStatus } from "#src/lifecycle/subagent";
export type { TurnBudget, TurnBudgetPhase } from "#src/lifecycle/turn-limits";
export type { SubagentHandoff } from "#src/lifecycle/child-lifecycle";
// The resume vocabulary is re-exported for the same reason: the record owns the
// reasons a resume is refused, and the manager adds the one that is not a fact
// about a record.
// Generative extension seam (ADR 0002, Phase 16 Step 2). The provider type
// and all four collaborator types it references are re-exported by name so
// consumers can import them directly rather than recovering them via
// indexed-access inference (e.g. `Parameters<WorkspaceProvider["prepare"]>[0]`).
export type {
  LifetimeUsage,
  ResumeRefusal,
  ResumeRefusalReason,
  Workspace,
  WorkspaceDisposeOutcome,
  WorkspaceDisposeResult,
  WorkspacePrepareContext,
  WorkspaceProvider,
};

/**
 * Serializable by-value snapshot of an agent's state.
 *
 * Produced by this package and read by consumers — not a contract third
 * parties implement, so a new field is a minor release. What earns a field a
 * place here (and what the snapshot deliberately withholds) is decided in
 * `docs/decisions/0005-subagent-record-admission-policy.md`.
 */
export interface SubagentRecord {
  id: string;
  type: string;
  description: string;
  status: SubagentStatus;
  /** Scheduling and announcement mode, resolved once at the manager choke point. */
  isBackground: boolean;
  result?: string;
  /** The question the agent ended its turn with, when it declared one. */
  pendingQuestion?: string;
  error?: string;
  toolUses: number;
  /**
   * The current run's turn budget: successful turns used, the ceiling (absent
   * when unlimited), and whether the harness has warned or stopped the run.
   * Live while the run is going; absent until its turn loop starts.
   */
  turnBudget?: TurnBudget;
  startedAt: number;
  completedAt?: number;
  lifetimeUsage: LifetimeUsage;
  compactionCount: number;
  /** Path to the agent's session JSONL, once the session exists. */
  outputFile?: string;
}

/** Options for resuming an agent via the service. */
export interface ResumeOptions {
  /**
   * Declare that the caller will deliver the resumed outcome to the parent,
   * suppressing the completion nudge for it. Omitted, the resumed outcome is
   * announced exactly as a background completion is.
   */
  claimOutcome?: boolean;
  /**
   * Cancels the resumed turn loop. It is wired through the record's own lever,
   * so it ends the resume exactly as `abort(id)` does — the record reads
   * `stopped`, and either cancel reaches the same run.
   */
  signal?: AbortSignal;
}

/**
 * What a resume attempt produced.
 *
 * A resumed run that *failed* is still `resumed` — the snapshot carries
 * `status: "error"` and the message. `refused` means no turn loop ran.
 */
export type ResumeResult =
  | { kind: "resumed"; record: SubagentRecord }
  | { kind: "refused"; reason: ResumeRefusalReason };

/** Options for spawning an agent via the service. */
export interface SpawnOptions {
  description?: string;
  model?: string;
  /**
   * Turn ceiling for the run. A value below 2 runs with 2: the result is the
   * child's final response, so it needs one turn to work and one to answer.
   * Omit for the agent's own limit, then the operator's default; 0 means unlimited.
   */
  maxTurns?: number;
  thinkingLevel?: string;
  inheritContext?: boolean;
  foreground?: boolean;
  bypassQueue?: boolean;
  /** Todo keys the agent takes over; forwarded as `handoff` on `subagents:child:session-created`. */
  todos?: string[];
  /** With `todos`: `assigned` (default) or `ledger`. */
  todoScope?: "assigned" | "ledger";
}

/** The public service contract for cross-extension subagent access. */
export interface SubagentsService {
  /** Spawn an agent. Returns the agent ID immediately. */
  spawn(type: string, prompt: string, options?: SpawnOptions): string;

  /** Get a snapshot of an agent's current state. */
  getRecord(id: string): SubagentRecord | undefined;

  /** List all tracked agents, most recent first. */
  listAgents(): SubagentRecord[];

  /** Abort a running or queued agent. Returns false if not found. */
  abort(id: string): boolean;

  /** Send a steering message to a running agent. */
  steer(id: string, message: string): Promise<boolean>;

  /**
   * Resume a settled agent with a new prompt, continuing its session.
   *
   * Resolves when the resumed run reaches a terminal state, carrying the
   * terminal snapshot — a caller that does not need the outcome can ignore the
   * promise. A refusal resolves promptly instead: the checks are synchronous
   * and no turn loop is started.
   */
  resume(id: string, prompt: string, options?: ResumeOptions): Promise<ResumeResult>;

  /** Wait for all running and queued agents to complete. */
  waitForAll(): Promise<void>;

  /** Whether any agents are running or queued. */
  hasRunning(): boolean;

  /**
   * Register the single workspace provider that supplies a child's working
   * directory plus bracketed setup/teardown. Throws if one is already
   * registered. Returns a disposer that unregisters the provider.
   */
  registerWorkspaceProvider(provider: WorkspaceProvider): () => void;
}

/** Event channel constants for pi.events subscriptions. */
export const SUBAGENT_EVENTS = {
  STARTED: "subagents:started",
  COMPLETED: "subagents:completed",
  FAILED: "subagents:failed",
  RESUMING: "subagents:resuming",
  RESUMED: "subagents:resumed",
  COMPACTED: "subagents:compacted",
  CREATED: "subagents:created",
  STEERED: "subagents:steered",
} as const;

// ---- Accessor functions ----

/** Legacy single slot, read directly by consumers of the published package. */
const SERVICE_KEY = Symbol.for("@gotgenes/pi-subagents:service");
/** Every published service, oldest first. */
const PUBLICATIONS_KEY = Symbol.for("@gotgenes/pi-subagents:services.v1");

interface Publication {
  service: SubagentsService;
  /** Absent while the publishing session's extensions are still loading. */
  sessionId?: string;
  seq: number;
}

interface Publications {
  next: number;
  entries: Publication[];
}

/**
 * Every child session loads this extension again in-process, so several
 * services are published at once.
 *
 * A service is published *pending* when its extension factory runs and
 * *started* on `session_start`. Companion extensions (e.g.
 * `@gotgenes/pi-subagents-worktrees`) call `getSubagentsService()` from their
 * own factory, right after this one, and must get the service of the session
 * that is loading, so the newest pending publication is the default. Once no
 * load is pending, the default is the outermost started service: a child starts
 * after its parent and shuts down before it.
 *
 * Pi can run factories without ever starting that session (a project-trust
 * bootstrap pass, a child whose creation failed). Such a pending publication
 * never shuts down, so it must not stay the default: a session that starts drops
 * every pending publication older than its own, and a failed child load
 * discards the ones it made (`discardPendingSince`).
 */
function publications(): Publications {
  const slots = globalThis as Record<symbol, unknown>;
  const store = slots[PUBLICATIONS_KEY] as Partial<Publications> | undefined;
  if (store && typeof store.next === "number" && Array.isArray(store.entries)) return store as Publications;
  const created: Publications = { next: 0, entries: [] };
  slots[PUBLICATIONS_KEY] = created;
  return created;
}

function current(store: Publications): SubagentsService | undefined {
  const newest = store.entries.at(-1);
  if (newest && newest.sessionId === undefined) return newest.service;
  return store.entries.find((entry) => entry.sessionId !== undefined)?.service;
}

function syncSlot(store: Publications): void {
  const slots = globalThis as Record<symbol, unknown>;
  const service = current(store);
  if (service) slots[SERVICE_KEY] = service;
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Symbol-keyed global property; Map.delete() is not applicable
  else delete slots[SERVICE_KEY];
}

/**
 * Publish a SubagentsService on globalThis for cross-extension access.
 *
 * Without a session id (from the extension factory) the publication is pending.
 * With one (from `session_start`) it is started: it keeps its place, replaces
 * any other publication for the same session, and drops older pending ones.
 */
export function publishSubagentsService(service: SubagentsService, sessionId?: string): void {
  const store = publications();
  const index = store.entries.findIndex((entry) =>
    entry.service === service || (sessionId !== undefined && entry.sessionId === sessionId));
  if (sessionId === undefined) {
    if (index < 0) store.entries.push({ service, seq: store.next++ });
  } else {
    const seq = index >= 0 ? store.entries[index].seq : store.next++;
    if (index >= 0) store.entries[index] = { service, sessionId, seq };
    else store.entries.push({ service, sessionId, seq });
    store.entries = store.entries.filter((entry) => entry.sessionId !== undefined || entry.seq > seq);
  }
  syncSlot(store);
}

/**
 * Retrieve a published SubagentsService.
 *
 * Without a session id: the service of the session whose extensions are
 * loading, if any, else the outermost started one (the top-level session's).
 * With one: that session's service, or undefined.
 */
export function getSubagentsService(sessionId?: string): SubagentsService | undefined {
  const store = publications();
  if (sessionId !== undefined) {
    return store.entries.find((entry) => entry.sessionId === sessionId)?.service;
  }
  return current(store);
}

/**
 * Remove one service (call on shutdown/reload). Only that publication goes; the
 * default moves on as described above.
 */
export function unpublishSubagentsService(service: SubagentsService): void {
  const store = publications();
  store.entries = store.entries.filter((entry) => entry.service !== service);
  syncSlot(store);
}

/** A mark to pass to `discardPendingSince` before loading a child's extensions. */
export function markPendingPublications(): number {
  return publications().next;
}

/**
 * Discard pending publications made since `mark`: a child load that failed
 * before its session started will never start or shut down.
 */
export function discardPendingSince(mark: number): void {
  const store = publications();
  store.entries = store.entries.filter((entry) => entry.sessionId !== undefined || entry.seq < mark);
  syncSlot(store);
}
