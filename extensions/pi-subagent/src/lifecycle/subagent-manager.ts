/**
 * subagent-manager.ts - Tracks subagents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are scheduled on a ConcurrencyLimiter and auto-started as running
 * agents complete. Foreground agents bypass the limiter (they block the parent anyway).
 */

import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import { composeAgentInstructions } from "#src/config/prompt-fragments";
import { debugLog } from "#src/debug";
import type { SubagentHandoff } from "#src/lifecycle/child-lifecycle";
import { type ReopenSource, reopenRefusal, resolveSavedModel } from "#src/lifecycle/cold-resume";
import type { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import {
  type ResumeRefusal,
  Subagent,
  type SubagentExecution,
  type SubagentLifecycleObserver,
} from "#src/lifecycle/subagent";
import type { SubagentSession } from "#src/lifecycle/subagent-session";
import { SubagentState } from "#src/lifecycle/subagent-state";
import type { PersistedSubagentRecord } from "#src/persisted-record";

import type { RunConfig } from "#src/runtime";
import type {
  AgentConfig,
  CompactionInfo,
  ParentSessionInfo,
  SubagentType,
  ThinkingLevel,
} from "#src/types";

/**
 * The agent-registry slice the manager needs to resolve a spawn. Deliberately
 * narrower than AgentConfigLookup, whose slice serves session assembly (ISP).
 */
export interface SpawnTypeResolver {
  resolveType(name: string): string | undefined;
  isValidType(type: string): boolean;
  resolveAgentConfig(type: string): AgentConfig;
}

/**
 * Why a resume was refused, across every front door.
 *
 * Widens the record's own vocabulary by the one refusal that is not a fact
 * about a record: an id no record answers to.
 */
export type ResumeRefusalReason = ResumeRefusal | "unknown-agent";

/**
 * What a resume attempt produced: the record whose run was restarted, or the
 * reason nothing was started.
 *
 * A resumed run that *failed* is still `resumed` — the record carries the
 * error. `refused` means the turn loop never ran.
 */
export type ResumeOutcome = { kind: "resumed"; record: Subagent } | ResumeRefused;

/**
 * Nothing was started. A refusal for good names the transcript when the agent
 * has one, which still holds what it did.
 */
export interface ResumeRefused {
  kind: "refused";
  reason: ResumeRefusalReason;
  transcriptPath?: string;
}

/**
 * What starting a resume produced: the record now running it, or the reason
 * nothing was started.
 *
 * The run itself continues on the record; its `promise` settles when the
 * resumed run reaches a terminal state.
 */
export type ResumeStart = { kind: "started"; record: Subagent } | ResumeRefused;

/**
 * Where a resume finds an agent this runtime holds no record of: the session's
 * saved records, and the parent a rebuilt agent then belongs to.
 */
export interface SavedAgents {
  /** The latest record for this ID on the current branch. */
  find(id: string): PersistedSubagentRecord | undefined;
  parent(): { snapshot: ParentSnapshot; parentSession: ParentSessionInfo };
}

/** Per-call knobs for a resume; both doors pass their own. */
export interface ResumeCallOptions {
  /** Cancels the resumed turn loop, through the record's own lever — so it ends like `abort(id)` does. */
  signal?: AbortSignal;
  /**
   * The caller will deliver this outcome to the parent, so nothing announces
   * it. Omitted, the resumed outcome is announced like any other completion.
   */
  claimOutcome?: boolean;
}

/** A spawn's resolved identity and mode — the invariants every front door shares. */
interface ResolvedSpawn {
  type: SubagentType;
  isBackground: boolean;
  /** Fragment-bearing configuration captured before queue admission. */
  agentConfig?: AgentConfig;
}

/**
 * Session-retention windows (minutes). `SettingsManager` satisfies this
 * structurally; a live getter (`getRetentionPolicy`) lets the sweep read the
 * current values without a construction-time settings dependency.
 */
export interface RetentionPolicy {
  readonly consumedSessionRetentionMinutes: number;
  readonly unconsumedSessionRetentionMinutes: number;
}

const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  consumedSessionRetentionMinutes: 10,
  unconsumedSessionRetentionMinutes: 720,
};

/**
 * Only what the retention rule reads. Narrower than `Subagent` so the rule
 * stays a plain function over four facts, testable without spawning an agent.
 */
export interface RetentionCandidate {
  consumed: boolean;
  completedAt: number | undefined;
  consumedAt: number | undefined;
  pendingQuestion: string | undefined;
}

/** When a terminal record's session-release window opened, and how long it runs. */
export interface RetentionWindow {
  referenceAt: number;
  windowMinutes: number;
}

/**
 * Pick the retention window for one terminal record.
 *
 * A collected outcome releases on the short window, measured from the later of
 * completion and collection, so a late read still gets a full resume window; an
 * uncollected one holds until the long safety cap.
 *
 * A record carrying an unanswered question is not collected, whatever
 * `consumed` says: the parent has read the question but has not answered it,
 * and the answer is delivered by resuming the very session the short window
 * would release.
 */
export function resolveRetentionWindow(
  record: RetentionCandidate,
  policy: RetentionPolicy,
): RetentionWindow {
  if (record.consumed && record.pendingQuestion === undefined) {
    return {
      referenceAt: Math.max(record.completedAt ?? 0, record.consumedAt ?? 0),
      windowMinutes: policy.consumedSessionRetentionMinutes,
    };
  }
  return {
    referenceAt: record.completedAt ?? 0,
    windowMinutes: policy.unconsumedSessionRetentionMinutes,
  };
}

/** Observer interface for agent lifecycle notifications. */
export interface SubagentManagerObserver {
  onSubagentWaiting?(record: Subagent): void;
  onSubagentQueued?(record: Subagent): void;
  onSubagentStarted(record: Subagent): void;
  /** Session ready, before first prompt: live viewers can subscribe without polling. */
  onSubagentSessionCreated?(record: Subagent): void;
  onSubagentCompleted(record: Subagent): void;
  /**
   * Fires when a resume starts, from whichever front door asked for it.
   * Required: a consumer that tracks the widget's live set has to learn that a
   * settled record went back to running, and the only alternative is polling.
   */
  onSubagentResuming(record: Subagent): void;
  /** Fires when a resumed run reaches a terminal state (distinct from a fresh completion). */
  onSubagentResumed(record: Subagent): void;
  /**
   * Fires when a running child sends its parent a mid-run message.
   * Optional: the widget has no use for it, and a hook nobody supplies is a
   * vacant one.
   */
  onSubagentUpdate?(record: Subagent, message: string): void;
  onSubagentCompacted(record: Subagent, info: CompactionInfo): void;
  /** Fires synchronously after a background agent record is created (before run). */
  onSubagentCreated(record: Subagent): void;
}

export interface SubagentManagerOptions {
  /** Assembly factory that produces a born-complete SubagentSession per spawn. */
  createSubagentSession: (params: CreateSubagentSessionParams) => Promise<SubagentSession>;
  /** Concurrency limiter — schedules background run thunks FIFO against the limit. */
  limiter: ConcurrencyLimiter;
  getRunConfig?: () => RunConfig;
  /** Live accessor for the session-retention windows; defaults applied when absent. */
  getRetentionPolicy?: () => RetentionPolicy;
  observer?: SubagentManagerObserver;
  /** Agent registry, consulted to canonicalize a spawn's type and resolve its config. */
  registry: SpawnTypeResolver;
  /** Absent, an agent with no live record is an unknown one. */
  savedAgents?: SavedAgents;
}

export interface AgentSpawnConfig {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /**
   * Whether the agent runs in the background. The caller decides; an agent
   * profile has no say. Required so a new front door cannot silently inherit
   * another's policy.
   */
  background: boolean;
  /**
   * Skip the maxConcurrent queue check for this spawn - start immediately even
   * if the configured concurrency limit would otherwise queue it. Useful for
   * callers (e.g. cross-extension RPC) that must not be deferred by the queue.
   */
  bypassQueue?: boolean;
  /** Parent abort signal - when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Per-subagent lifecycle observer — replaces onSessionCreated callback. */
  observer?: SubagentLifecycleObserver;
  /** Parent session identity - grouped fields that travel together from the tool boundary. */
  parentSession?: ParentSessionInfo;
  /** What the parent hands the child; forwarded on its `session-created` event. */
  handoff?: SubagentHandoff;
  /** Existing directory the child runs in, chosen by the caller; absent, the parent's. */
  cwd?: string;
}

/** A refusal, naming the transcript unless it is only a refusal of now. */
function refused(reason: ResumeRefusal, transcriptPath: string | undefined): ResumeRefused {
  return {
    kind: "refused",
    reason,
    ...(transcriptPath && reason !== "still-running" ? { transcriptPath } : {}),
  };
}

export class SubagentManager {
  private agents = new Map<string, Subagent>();
  private sweepInterval: ReturnType<typeof setInterval>;
  private readonly observer?: SubagentManagerObserver;
  private readonly createSubagentSession: (
    params: CreateSubagentSessionParams,
  ) => Promise<SubagentSession>;
  private readonly limiter: ConcurrencyLimiter;
  private getRunConfig?: () => RunConfig;
  private getRetentionPolicy?: () => RetentionPolicy;
  private readonly registry: SpawnTypeResolver;
  private readonly savedAgents?: SavedAgents;

  constructor(options: SubagentManagerOptions) {
    this.createSubagentSession = options.createSubagentSession;
    this.limiter = options.limiter;
    this.observer = options.observer;
    this.getRunConfig = options.getRunConfig;
    this.getRetentionPolicy = options.getRetentionPolicy;
    this.registry = options.registry;
    this.savedAgents = options.savedAgents;
    // Periodically release the heavy session of terminal agents past their
    // retention window. The lightweight record (with its result) is kept for the
    // session lifetime, so subagent_get never misses in-session.
    this.sweepInterval = setInterval(() => this.sweep(), 60_000);
    this.sweepInterval.unref();
  }

  /**
   * Compose a per-agent lifecycle observer from manager and spawn-config concerns.
   *
   * Terminal transitions are reported for every agent. Whether the parent needs
   * telling is the notification layer's decision, made from the carrier claim;
   * suppressing the observer here would also suppress the lifecycle event and
   * the session-history record, which are facts about the run rather than
   * announcements. Observer faults on the session-created and terminal hooks
   * must not fail the run.
   */
  private buildObserver(spawnObserver?: SubagentLifecycleObserver): SubagentLifecycleObserver {
    const observer = this.observer;
    const guarded = (name: string, notify: (agent: Subagent) => void) => (agent: Subagent) => {
      try {
        notify(agent);
      } catch (err) {
        debugLog(`${name} observer`, err);
      }
    };
    const sessionCreated = guarded("onSubagentSessionCreated", (agent) =>
      observer?.onSubagentSessionCreated?.(agent),
    );
    return {
      onWaiting: guarded("onSubagentWaiting", (agent) => observer?.onSubagentWaiting?.(agent)),
      onQueued: guarded("onSubagentQueued", (agent) => observer?.onSubagentQueued?.(agent)),
      onStarted: (agent) => observer?.onSubagentStarted(agent),
      onSessionCreated: (agent) => {
        sessionCreated(agent);
        spawnObserver?.onSessionCreated?.(agent);
      },
      onRunFinished: guarded("onSubagentCompleted", (agent) =>
        observer?.onSubagentCompleted(agent),
      ),
      onResumeStarted: guarded("onSubagentResuming", (agent) =>
        observer?.onSubagentResuming(agent),
      ),
      onResumeFinished: guarded("onSubagentResumed", (agent) => observer?.onSubagentResumed(agent)),
      onUpdateSent: (agent, message) => observer?.onSubagentUpdate?.(agent, message),
      onCompacted: (agent, info) => observer?.onSubagentCompacted(agent, info),
    };
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   *
   * Throws when the named agent type is disabled or its file does not parse.
   */
  spawn(
    snapshot: ParentSnapshot,
    type: SubagentType,
    prompt: string,
    options: AgentSpawnConfig,
  ): string {
    return this.create(
      snapshot,
      this.resolveSpawn(type, options.background, snapshot),
      prompt,
      options,
    );
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   *
   * The caller holds the result, which is a delivery commitment: the agent must
   * not be queued and must not be announced, whatever its frontmatter declares.
   *
   * Rejects when the named agent type is disabled or its file does not parse.
   */
  async spawnAndWait(
    snapshot: ParentSnapshot,
    type: SubagentType,
    prompt: string,
    options: Omit<AgentSpawnConfig, "background">,
  ): Promise<Subagent> {
    const id = this.create(snapshot, this.resolveSpawn(type, false, snapshot), prompt, {
      ...options,
      background: false,
    });
    const record = this.agents.get(id)!;
    // The caller holds the result, so this call is the carrier: claim the outcome
    // before awaiting it, so nothing announces what is already being delivered.
    record.claim();
    await record.promise;
    return record;
  }

  /**
   * Stamp the invariants every front door shares: a canonical agent type, a
   * rejection for a disabled one, and the background mode.
   */
  private resolveSpawn(type: string, background: boolean, snapshot: ParentSnapshot): ResolvedSpawn {
    const canonical = this.registry.resolveType(type);
    if (canonical !== undefined && !this.registry.isValidType(canonical)) {
      const { definitionError } = this.registry.resolveAgentConfig(canonical);
      throw new Error(
        definitionError
          ? `Agent type "${canonical}" cannot load: ${definitionError}`
          : `Agent type "${canonical}" is disabled`,
      );
    }
    const resolvedType = canonical ?? "general-purpose";
    // Validate every selected declaration now. Resolve fragments while the
    // request is made, not when a queue slot opens; later edits/reloads cannot
    // change a fragment-bearing child. Profiles without fragments keep their
    // existing run-start registry resolution.
    const profile = this.registry.resolveAgentConfig(resolvedType);
    const instructions = composeAgentInstructions(profile, {
      projectTrusted: snapshot.projectTrusted,
    });
    let agentConfig: AgentConfig | undefined;
    if (instructions.fragments.length > 0) {
      agentConfig = structuredClone(profile);
      agentConfig.systemPrompt = instructions.systemPrompt;
      if (agentConfig.toolNames) Object.freeze(agentConfig.toolNames);
      if (agentConfig.fragments) Object.freeze(agentConfig.fragments);
      if (Array.isArray(agentConfig.locked)) Object.freeze(agentConfig.locked);
      Object.freeze(agentConfig);
    }
    return {
      type: resolvedType,
      isBackground: background,
      agentConfig,
    };
  }

  /** The execution machinery every record shares, around its own per-run knobs. */
  private execution(
    snapshot: ParentSnapshot,
    resolved: ResolvedSpawn,
    prompt: string,
    knobs: Omit<
      SubagentExecution,
      | "createSubagentSession"
      | "snapshot"
      | "agentConfig"
      | "prompt"
      | "getRunConfig"
      | "checkReopen"
    >,
  ): SubagentExecution {
    return {
      createSubagentSession: this.createSubagentSession,
      snapshot,
      agentConfig: resolved.agentConfig,
      prompt,
      getRunConfig: this.getRunConfig,
      checkReopen: (source) => this.checkReopen(source),
      scheduleActivation: (task) => this.limiter.schedule(task),
      ...knobs,
    };
  }

  /** Create, register, and start (or queue) a record for an already-resolved spawn. */
  private create(
    snapshot: ParentSnapshot,
    resolved: ResolvedSpawn,
    prompt: string,
    options: AgentSpawnConfig,
  ): string {
    const { type, isBackground } = resolved;
    const id = randomUUID().slice(0, 17);
    const record = new Subagent({
      id,
      type,
      description: options.description,
      isBackground,
      state: new SubagentState({
        status: isBackground ? "queued" : "running",
        startedAt: Date.now(),
      }),
      execution: this.execution(snapshot, resolved, prompt, {
        observer: this.buildObserver(options.observer),
        model: options.model,
        maxTurns: options.maxTurns,
        thinkingLevel: options.thinkingLevel,
        parentSession: options.parentSession,
        ...(options.handoff ? { handoff: options.handoff } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        signal: options.signal,
      }),
    });
    this.agents.set(id, record);

    if (isBackground) {
      this.observer?.onSubagentCreated(record);
    }

    if (isBackground && !options.bypassQueue) {
      // Schedule on the limiter — scheduleVia captures the limiter promise
      // eagerly, so a queued agent is awaitable from spawn; guardedRun guards
      // against abort-while-queued when the slot frees.
      record.scheduleVia((thunk) => this.limiter.schedule(thunk));
      return id;
    }

    record.start();
    return id;
  }

  /**
   * Resume an existing agent session with a new prompt.
   *
   * The refusal policy lives here rather than in a caller, so every front door
   * declines the same resumes for the same reasons; a door owns only how it
   * words the answer. Delegates to Subagent.resume(), which owns the observer
   * subscription lifecycle, and reopens the transcript when the session is gone.
   */
  async resume(
    id: string,
    prompt: string,
    options: ResumeCallOptions = {},
  ): Promise<ResumeOutcome> {
    const start = this.startResume(id, prompt, options);
    if (start.kind === "refused") return start;
    await start.record.promise;
    return { kind: "resumed", record: start.record };
  }

  /**
   * Start a resume without waiting for it: the door that returns before the
   * resumed run ends. Refuses synchronously, for the same reasons `resume` does.
   */
  startResume(id: string, prompt: string, options: ResumeCallOptions = {}): ResumeStart {
    const live = this.agents.get(id);
    const saved = live ? undefined : this.savedAgents?.find(id);
    if (!live && !saved) return { kind: "refused", reason: "unknown-agent" };
    const source = live ?? saved!;
    if (
      live &&
      (live.status === "waiting" || (live.status === "queued" && live.isSessionReady()))
    ) {
      void live.steer(prompt, options.signal);
      if (options.claimOutcome) live.claim();
      else live.releaseClaims();
      return { kind: "started", record: live };
    }
    const refusal = this.resumeRefusalFor(source);
    if (refusal) return refused(refusal, source.outputFile);
    let agent: Subagent;
    try {
      agent = live ?? this.rebuildFromSaved(saved!);
    } catch (err) {
      // Its profile no longer composes (say, a fragment file went away).
      debugLog(`rebuild agent ${id}`, err);
      return refused("agent-type-unavailable", source.outputFile);
    }
    // Before the resume starts: resetForResume runs synchronously inside
    // resume(), so a claim taken afterwards would miss the terminal edge.
    // Each resume's caller decides who carries this run's outcome; a claim a
    // previous carrier left behind belongs to an outcome already delivered, and
    // no carrier is live on a settled record.
    if (options.claimOutcome) agent.claim();
    else agent.releaseClaims();
    // Published as agent.promise, which always resolves; it rejects only for a
    // missing session, which resumeRefusal has already refused as no-session.
    void agent.resume(prompt, options.signal);
    return { kind: "started", record: agent };
  }

  /**
   * Why a resume of this agent would be refused, or undefined when one would be
   * accepted: the one check `startResume` and every report on an agent share.
   * A live record answers for itself, whatever `source` says.
   */
  resumeRefusalFor(source: { id: string } & ReopenSource): ResumeRefusal | undefined {
    const live = this.agents.get(source.id);
    if (live) return live.resumeRefusal;
    return source.outputFile ? this.checkReopen(source) : "no-session";
  }

  private checkReopen(source: ReopenSource) {
    return reopenRefusal(source, (type) => {
      const canonical = this.registry.resolveType(type);
      return canonical !== undefined && this.registry.isValidType(canonical);
    });
  }

  /**
   * A record for an agent the runtime has forgotten, whose session is already
   * released: resuming it reopens the saved transcript. Under the agent's own ID,
   * so results, steering and notifications work as they did. The profile is the
   * current one for its type; the transcript carries everything else it knew.
   */
  private rebuildFromSaved(saved: PersistedSubagentRecord): Subagent {
    const { snapshot, parentSession } = this.savedAgents!.parent();
    const resolved = this.resolveSpawn(saved.type, true, snapshot);
    const model = resolveSavedModel(saved.model, snapshot.modelRegistry);
    const record = new Subagent({
      id: saved.id,
      type: resolved.type,
      description: saved.description,
      isBackground: resolved.isBackground,
      state: new SubagentState({
        // A record still reading queued or running was interrupted.
        status:
          saved.status === "queued" || saved.status === "running" || saved.status === "waiting"
            ? "stopped"
            : saved.status,
        result: saved.result,
        error: saved.error,
        startedAt: saved.startedAt,
        completedAt: saved.completedAt,
        toolUses: saved.toolUses,
        pendingQuestion: saved.pendingQuestion,
        turnBudget: saved.turnBudget,
      }),
      released: {
        outputFile: saved.outputFile,
        model,
        thinkingLevel: saved.thinkingLevel,
      },
      execution: this.execution(snapshot, resolved, "", {
        observer: this.buildObserver(),
        model,
        maxTurns: saved.maxTurns,
        thinkingLevel: saved.thinkingLevel,
        parentSession,
        cwd: saved.cwd,
      }),
    });
    this.agents.set(saved.id, record);
    return record;
  }

  getRecord(id: string): Subagent | undefined {
    return this.agents.get(id);
  }

  listAgents(): Subagent[] {
    return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  abort(id: string): boolean {
    return this.agents.get(id)?.abort() ?? false;
  }

  /**
   * Remove a record from the map and tear its session down.
   * The map is updated first so the record is unreachable while its child's
   * extensions shut down.
   */
  private removeRecord(id: string, record: Subagent): Promise<void> {
    this.agents.delete(id);
    return record.disposeSession();
  }

  /**
   * Release the heavy session of any terminal agent past its retention window.
   * The record (with its result) is retained for the session lifetime; only the
   * live `AgentSession` is freed. `resolveRetentionWindow` owns which window
   * applies.
   */
  private sweep() {
    const policy = this.getRetentionPolicy?.() ?? DEFAULT_RETENTION_POLICY;
    const now = Date.now();
    for (const record of this.agents.values()) {
      if (record.isActive()) continue;
      if (!record.isSessionReady()) continue; // already released, or never had a session
      const { referenceAt, windowMinutes } = resolveRetentionWindow(record, policy);
      // Fire-and-forget: the sweep runs on an interval with no one to await it,
      // and Subagent.releaseSession() already swallows a failing teardown.
      if (now - referenceAt >= windowMinutes * 60_000) void record.releaseSession();
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   */
  async clearCompleted(): Promise<void> {
    const teardowns: Promise<void>[] = [];
    for (const [id, record] of this.agents) {
      if (record.isActive()) continue;
      teardowns.push(this.removeRecord(id, record));
    }
    await Promise.all(teardowns);
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    for (const record of this.agents.values()) {
      if (record.abort()) count++;
    }
    // Drop pending thunks (their promises resolve).
    this.limiter.clear();
    return count;
  }

  /**
   * Tear down every record, resolving once each child's extensions have shut
   * down. The registry is emptied before the teardowns are awaited, so nothing
   * can reach a dying record; `allSettled` keeps one failing child from
   * abandoning its siblings.
   */
  async dispose(): Promise<void> {
    clearInterval(this.sweepInterval);
    // Drop pending thunks
    this.limiter.clear();
    const teardowns = [...this.agents.values()].map((record) => record.disposeSession());
    this.agents.clear();
    await Promise.allSettled(teardowns);
  }
}
