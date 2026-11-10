/**
 * subagent-manager.ts - Tracks subagents, background execution, message delivery.
 *
 * Every agent runs in the background and is subject to a configurable
 * concurrency limit (default: 4). Excess agents are scheduled on a
 * ConcurrencyLimiter and auto-started as running agents complete.
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
  type SendOutcome,
  type SendRefusal,
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
 * Why a message was refused, across every front door.
 *
 * Widens the record's own vocabulary by the one refusal that is not a fact
 * about a record: an id no record answers to.
 */
export type SendRefusalReason = SendRefusal | "unknown-agent";

/**
 * Nothing was done. A refusal for good names the transcript when the agent
 * has one, which still holds what it did.
 */
export interface SendRefused {
  kind: "refused";
  reason: SendRefusalReason;
  transcriptPath?: string;
}

/**
 * What sending an agent a message produced: how it reached the agent (see
 * `SendOutcome`) and the record it reached, or the reason nothing was done.
 *
 * A run the message started continues on the record; its `promise` settles when
 * the run reaches a terminal state. A run that *fails* is still `started`: the
 * record carries the error. `refused` means the message went nowhere.
 */
export type SendResult =
  | (Exclude<SendOutcome, { kind: "refused" }> & { record: Subagent })
  | SendRefused;

/**
 * Where a message finds an agent this runtime holds no record of: the session's
 * saved records, and the parent a rebuilt agent then belongs to.
 */
export interface SavedAgents {
  /** The latest record for this ID on the current branch. */
  find(id: string): PersistedSubagentRecord | undefined;
  parent(): { snapshot: ParentSnapshot; parentSession: ParentSessionInfo };
}

/** Per-call knobs for a send. */
export interface SendCallOptions {
  /** Cancels the run the message starts, through the record's own lever — so it ends like `abort(id)` does. */
  signal?: AbortSignal;
}

/** A spawn's resolved identity — the invariants every front door shares. */
interface ResolvedSpawn {
  type: SubagentType;
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
 * stays a plain function over three facts, testable without spawning an agent.
 * `consumed` means the parent read the finished result with `subagent_get`.
 */
export interface RetentionCandidate {
  consumed: boolean;
  completedAt: number | undefined;
  consumedAt: number | undefined;
}

/** When a terminal record's session-release window opened, and how long it runs. */
export interface RetentionWindow {
  referenceAt: number;
  windowMinutes: number;
}

/**
 * Pick the retention window for one terminal record.
 *
 * A result the parent read releases on the short window, measured from the
 * later of completion and the read, so a late read still gets a full resume
 * window; one nobody read holds until the long safety cap.
 */
export function resolveRetentionWindow(
  record: RetentionCandidate,
  policy: RetentionPolicy,
): RetentionWindow {
  if (record.consumed) {
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
  /**
   * Fires when a run ended and the agent is idle on open work (waiting, not done), and again
   * when the work it waits on changes. No completion is reported while it waits. Optional: a
   * consumer that does not show waiting agents has no use for it.
   */
  onSubagentWaiting?(record: Subagent): void;
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
  /**
   * Fires when a resume had to wait for a concurrency slot, so the record went
   * back to queued without starting. Optional: a resume admitted at once never
   * fires it, and `onSubagentResuming` follows when a queued one begins.
   */
  onSubagentResumeQueued?(record: Subagent): void;
  /** Fires when a resumed run reaches a terminal state (distinct from a fresh completion). */
  onSubagentResumed(record: Subagent): void;
  /**
   * Fires when a running child sends its parent a mid-run message.
   * Optional: the widget has no use for it, and a hook nobody supplies is a
   * vacant one.
   */
  onSubagentUpdate?(record: Subagent, message: string): void;
  /**
   * Fires when a child asks its parent a question: the child waits on a question item in its
   * own host, and the parent is told here. Optional, like the update hook.
   */
  onSubagentQuestion?(record: Subagent, question: string): void;
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
   * Skip the maxConcurrent queue check for this spawn - start immediately even
   * if the configured concurrency limit would otherwise queue it, and without
   * taking a slot. It governs the spawn's first run only: a resume of the agent
   * always goes through the limiter, however the agent was spawned. Nothing in
   * production sets it (the cross-extension RPC it served was removed); only
   * tests do.
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
function refused(reason: SendRefusal, transcriptPath: string | undefined): SendRefused {
  return {
    kind: "refused",
    reason,
    ...(transcriptPath && reason !== "rebuilding" ? { transcriptPath } : {}),
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
   * Terminal transitions are reported for every agent, and the notification
   * layer announces each one to the parent. Observer faults on the
   * session-created and terminal hooks must not fail the run.
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
      onResumeQueued: guarded("onSubagentResumeQueued", (agent) =>
        observer?.onSubagentResumeQueued?.(agent),
      ),
      onResumeFinished: guarded("onSubagentResumed", (agent) => observer?.onSubagentResumed(agent)),
      onUpdateSent: (agent, message) => observer?.onSubagentUpdate?.(agent, message),
      onQuestionAsked: (agent, question) => observer?.onSubagentQuestion?.(agent, question),
      onCompacted: (agent, info) => observer?.onSubagentCompacted(agent, info),
    };
  }

  /**
   * Spawn an agent and return its ID immediately; the parent learns the outcome
   * from the completion message. If the concurrency limit is reached, the agent
   * is queued.
   *
   * Throws when the named agent type is disabled or its file does not parse.
   */
  spawn(
    snapshot: ParentSnapshot,
    type: SubagentType,
    prompt: string,
    options: AgentSpawnConfig,
  ): string {
    return this.create(snapshot, this.resolveSpawn(type, snapshot), prompt, options);
  }

  /**
   * Stamp the invariants every front door shares: a canonical agent type, a
   * rejection for a disabled one.
   */
  private resolveSpawn(type: string, snapshot: ParentSnapshot): ResolvedSpawn {
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
      | "admit"
      | "snapshot"
      | "agentConfig"
      | "prompt"
      | "getRunConfig"
      | "checkReopen"
    >,
  ): SubagentExecution {
    return {
      createSubagentSession: this.createSubagentSession,
      // Every resume goes through the limiter, like the first run does.
      admit: (thunk) => this.limiter.schedule(thunk),
      snapshot,
      agentConfig: resolved.agentConfig,
      prompt,
      getRunConfig: this.getRunConfig,
      checkReopen: (source) => this.checkReopen(source),
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
    const { type } = resolved;
    const id = randomUUID().slice(0, 17);
    const record = new Subagent({
      id,
      type,
      description: options.description,
      state: new SubagentState({ status: "queued", startedAt: Date.now() }),
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

    this.observer?.onSubagentCreated(record);

    if (!options.bypassQueue) {
      // Schedule on the limiter — scheduleVia captures the limiter promise
      // eagerly, so a queued agent has a run promise from spawn; begin() guards
      // against abort-while-queued when the slot frees.
      record.scheduleVia((thunk) => this.limiter.schedule(thunk));
      return id;
    }

    record.start();
    return id;
  }

  /**
   * Give an agent a message, without waiting for what it does with it: steer a
   * running agent, fold the message into a queued one's waiting run, or start a
   * run for an idle one (see `Subagent.send`).
   *
   * The refusal policy lives here rather than in a caller, so every front door
   * declines the same messages for the same reasons; a door owns only how it
   * words the answer. An agent this runtime has forgotten is rebuilt from the
   * branch's saved record when its transcript can be reopened. Whatever run the
   * message starts reports to the parent as a completion message like any other
   * run.
   */
  async send(id: string, message: string, options: SendCallOptions = {}): Promise<SendResult> {
    const live = this.agents.get(id);
    const saved = live ? undefined : this.savedAgents?.find(id);
    if (!live && !saved) return { kind: "refused", reason: "unknown-agent" };
    const source = live ?? saved!;
    const refusal = this.sendRefusalFor(source);
    if (refusal) return refused(refusal, source.outputFile);
    let agent: Subagent;
    try {
      agent = live ?? this.rebuildFromSaved(saved!);
    } catch (err) {
      // Its profile no longer composes (say, a fragment file went away).
      debugLog(`rebuild agent ${id}`, err);
      return refused("agent-type-unavailable", source.outputFile);
    }
    const outcome = await agent.send(message, options.signal);
    if (outcome.kind === "refused") return refused(outcome.reason, agent.outputFile);
    return { ...outcome, record: agent };
  }

  /**
   * Why a message to this agent would be refused, or undefined when one would be
   * accepted: the one check `send` and every report on an agent share. A live
   * record answers for itself, whatever `source` says. A saved record with no
   * transcript never got a session, and its original task died with the process
   * that held it, so there is nothing to start a first run from.
   */
  sendRefusalFor(source: { id: string } & ReopenSource): SendRefusal | undefined {
    const live = this.agents.get(source.id);
    if (live) return live.sendRefusal;
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
   * released: sending it a message reopens the saved transcript. Under the agent's
   * own ID, so results, messages and notifications work as they did. The profile is the
   * current one for its type; the transcript carries everything else it knew.
   */
  private rebuildFromSaved(saved: PersistedSubagentRecord): Subagent {
    const { snapshot, parentSession } = this.savedAgents!.parent();
    const resolved = this.resolveSpawn(saved.type, snapshot);
    const model = resolveSavedModel(saved.model, snapshot.modelRegistry);
    const record = new Subagent({
      id: saved.id,
      type: resolved.type,
      description: saved.description,
      state: new SubagentState({
        // A record still reading queued or running was interrupted. The saved
        // record has no live run behind it, so it is idle either way.
        status: "idle",
        outcome: saved.status === "idle" ? saved.outcome : "interrupted",
        result: saved.result,
        error: saved.error,
        startedAt: saved.startedAt,
        completedAt: saved.completedAt,
        toolUses: saved.toolUses,
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
   * Release the heavy session of any terminal agent past its retention window,
   * unless it still has open work. The record (with its result) is retained for
   * the session lifetime; only the live `AgentSession` is freed.
   * `resolveRetentionWindow` owns which window applies.
   */
  private sweep() {
    const policy = this.getRetentionPolicy?.() ?? DEFAULT_RETENTION_POLICY;
    const now = Date.now();
    for (const record of this.agents.values()) {
      if (record.isActive()) continue;
      if (!record.isSessionReady()) continue; // already released, or never had a session
      // Open work lives in the session and its completion lands there: an agent waiting on a
      // job, an agent of its own or a question (an item like the others) keeps its session however
      // long it waits. (Step 11 owns the full rule; this is the one condition correctness needs
      // before it.)
      if (record.hasOpenWork()) continue;
      const { referenceAt, windowMinutes } = resolveRetentionWindow(record, policy);
      // Fire-and-forget: the sweep runs on an interval with no one to await it,
      // and Subagent.releaseSession() already swallows a failing teardown.
      if (now - referenceAt >= windowMinutes * 60_000) void record.releaseSession();
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   *
   * Like a running or queued agent, an agent waiting on open work stays. Disposing it here would
   * be silent: it reports nothing, so the spawner's item for it would stay open for good and the
   * widget and dashboard would keep showing it waiting. It ends the way every live agent does:
   * its work completes and it reports, it is stopped (which reports), or the spawning session
   * shuts down (`abortAll` then `dispose`).
   */
  async clearCompleted(): Promise<void> {
    const teardowns: Promise<void>[] = [];
    for (const [id, record] of this.agents) {
      if (record.isActive() || record.hasOpenWork()) continue;
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
