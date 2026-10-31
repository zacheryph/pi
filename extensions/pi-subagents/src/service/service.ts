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

/** Legacy single slot: always the outermost live service. */
const SERVICE_KEY = Symbol.for("@gotgenes/pi-subagents:service");
/** Every live service in session-start order; the slot mirrors the first. */
const PUBLICATIONS_KEY = Symbol.for("@gotgenes/pi-subagents:services.v1");

interface Publication {
  service: SubagentsService;
  sessionId: string;
}

/**
 * Every child session loads this extension again in-process, so several
 * services are live at once. A child starts after its parent and shuts down
 * before it, so start order puts the outermost session first.
 *
 * Only started sessions are admitted. Pi may run extension factories in
 * invocations that never start a session (and so never shut one down); a
 * publication made at load time could then sit ahead of every later session.
 */
function publications(): Publication[] {
  const slots = globalThis as Record<symbol, unknown>;
  const list = slots[PUBLICATIONS_KEY];
  if (Array.isArray(list)) return list as Publication[];
  const created: Publication[] = [];
  slots[PUBLICATIONS_KEY] = created;
  return created;
}

function syncSlot(list: Publication[]): void {
  const slots = globalThis as Record<symbol, unknown>;
  const first = list[0];
  if (first) slots[SERVICE_KEY] = first.service;
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Symbol-keyed global property; Map.delete() is not applicable
  else delete slots[SERVICE_KEY];
}

/**
 * Publish a session's SubagentsService on globalThis for cross-extension
 * access. Call on `session_start`.
 *
 * A later (child) session never displaces the outermost one from the slot. A
 * publication for a session id that is already published replaces it in place,
 * so an instance whose shutdown never unpublished cannot linger.
 */
export function publishSubagentsService(service: SubagentsService, sessionId: string): void {
  const list = publications();
  const index = list.findIndex((entry) => entry.service === service || entry.sessionId === sessionId);
  if (index >= 0) list[index] = { service, sessionId };
  else list.push({ service, sessionId });
  syncSlot(list);
}

/**
 * Retrieve a published SubagentsService.
 *
 * Without a session id: the outermost live service (the top-level session's).
 * With one: that session's service, or undefined.
 */
export function getSubagentsService(sessionId?: string): SubagentsService | undefined {
  if (sessionId !== undefined) {
    return publications().find((entry) => entry.sessionId === sessionId)?.service;
  }
  return (globalThis as Record<symbol, unknown>)[SERVICE_KEY] as
    | SubagentsService
    | undefined;
}

/**
 * Remove one service (call on shutdown/reload). Only that publication goes; the
 * slot moves to the next outermost live service, if any.
 */
export function unpublishSubagentsService(service: SubagentsService): void {
  const list = publications();
  const index = list.findIndex((entry) => entry.service === service);
  if (index >= 0) list.splice(index, 1);
  syncSlot(list);
}
