/**
 * subagent.ts — Subagent class: identity, lifecycle status, and per-subagent behavior.
 *
 * Status/stats are delegated to the SubagentState value object; listener
 * lifecycle to RunListeners.
 * Behavior (abort, steer buffering) lives here rather than on SubagentManager.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { debugLog } from "#src/debug";
import type { SubagentHandoff } from "#src/lifecycle/child-lifecycle";
import type { ReopenRefusal, ReopenSource } from "#src/lifecycle/cold-resume";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { type Admission, Run, type RunInit } from "#src/lifecycle/run";
import type { SubagentSession, TurnLoopResult } from "#src/lifecycle/subagent-session";
import {
  type CarrierClaim,
  type SettledOutcome,
  SubagentState,
  type SubagentStatus,
} from "#src/lifecycle/subagent-state";
import type { TurnBudget } from "#src/lifecycle/turn-limits";
import type { LifetimeUsage } from "#src/lifecycle/usage";
import { subscribeSubagentObserver } from "#src/observation/record-observer";
import type { RunConfig } from "#src/runtime";
import type {
  CompactionInfo,
  ParentSessionInfo,
  SessionMessage,
  SubagentType,
  ThinkingLevel,
} from "#src/types";

/** Per-subagent lifecycle observer — created by SubagentManager for each spawn. */
export interface SubagentLifecycleObserver {
  /** Fires when the subagent transitions to running (inside run(), after markRunning). */
  onStarted?(agent: Subagent): void;
  /** Fires once the session is created — the subagent's subagentSession is now available. */
  onSessionCreated?(agent: Subagent): void;
  /** Fires once when the run completes or fails (for concurrency drain). */
  onRunFinished?(agent: Subagent): void;
  /**
   * Fires once a resumed run is under way — after the record is rewound, so a
   * subscriber reading it sees the run that just started rather than the
   * outcome of the one it replaced.
   */
  onResumeStarted?(agent: Subagent): void;
  /** Fires once when a resumed run reaches a terminal state. */
  onResumeFinished?(agent: Subagent): void;
  /** Fires when the running agent sends its parent a mid-run message. */
  onUpdateSent?(agent: Subagent, message: string): void;
  /** Fires on compaction events during the run. */
  onCompacted?(agent: Subagent, info: CompactionInfo): void;
}

export type { SubagentStatus } from "#src/lifecycle/subagent-state";

/**
 * Why a resume of an agent would be refused.
 *
 * `still-running` is the one transient member: it is a refusal of *now* rather
 * than of ever, and the carriers word it accordingly.
 */
export type ResumeRefusal = "still-running" | "no-session" | ReopenRefusal;

/**
 * The result of a steer attempt. `Subagent.steer` owns the non-running
 * rejection rule and reports it here, so coordinators switch on the outcome
 * instead of pre-checking status (tell by id, with outcomes).
 */
export type SteerOutcome =
  | { kind: "delivered" }
  | { kind: "buffered" }
  | { kind: "rejected"; status: SubagentStatus };

/**
 * What happened to the run a `waitUntilSettled` call waited on: it settled and
 * is still the current run; it has not settled (the wait was interrupted, or
 * there was no run to wait on); or a resume replaced it after it settled,
 * carrying what it ended with.
 */
export type WaitOutcome =
  | { kind: "settled" }
  | { kind: "unsettled" }
  | { kind: "superseded"; outcome: SettledOutcome };

/**
 * The execution machinery a Subagent needs to run. A single mandatory
 * collaborator: production (SubagentManager.spawn) always supplies it, so run()
 * needs no "not configured" guards. The genuinely-optional behavior knobs stay
 * optional; the four inputs run() cannot proceed without are required.
 */
export interface SubagentExecution {
  /** Assembly factory that produces a born-complete SubagentSession. */
  createSubagentSession: (params: CreateSubagentSessionParams) => Promise<SubagentSession>;
  /** Immutable spawn-time parent snapshot handed to the session factory. */
  snapshot: ParentSnapshot;
  /** Prepared spawn-time config for fragment profiles; others use live lookup. */
  agentConfig?: CreateSubagentSessionParams["agentConfig"];
  /** Initial prompt for the turn loop. */
  prompt: string;
  observer?: SubagentLifecycleObserver;
  getRunConfig?: () => RunConfig;
  model?: Model<any>;
  maxTurns?: number;
  thinkingLevel?: ThinkingLevel;
  parentSession?: ParentSessionInfo;
  /** Forwarded to the child's `session-created` event. */
  handoff?: SubagentHandoff;
  /** Caller-chosen directory the child runs in; absent, the parent's. */
  cwd?: string;
  signal?: AbortSignal;
  /**
   * Why a released session's transcript cannot be reopened, or undefined when it
   * can. Absent, a released session stays released.
   */
  checkReopen?: (source: ReopenSource) => ReopenRefusal | undefined;
}

/** What a record built from a saved entry knows about the session it no longer has. */
export interface ReleasedSessionInfo {
  outputFile: string | undefined;
  model: Model<any> | undefined;
  thinkingLevel: ThinkingLevel | undefined;
}

export interface SubagentInit {
  // Identity
  id: string;
  type: SubagentType;
  description: string;
  /** The mode SubagentManager resolved for this spawn; drives scheduling and announcement. */
  isBackground: boolean;

  /** Execution machinery — always supplied; construct-complete, no test fallbacks. */
  execution: SubagentExecution;

  /** Lifecycle status and metrics. Defaults to a fresh queued state. */
  state?: SubagentState;

  /** Present on a record rebuilt from a saved entry: its session is already gone. */
  released?: ReleasedSessionInfo;
}

export class Subagent {
  // Identity — set once at construction
  readonly id: string;
  readonly type: SubagentType;
  readonly description: string;
  /**
   * Whether this agent runs in the background. Resolved once at the manager
   * choke point, so a consumer asks the record rather than re-deriving it from
   * a per-call display snapshot only the tool door ever built (#724).
   */
  readonly isBackground: boolean;

  // Lifecycle status and metrics — owned by a private value object; getters and
  // mutation methods below delegate to it one line.
  private readonly state: SubagentState;
  get status(): SubagentStatus {
    return this.state.status;
  }
  get result(): string | undefined {
    return this.state.result;
  }
  get error(): string | undefined {
    return this.state.error;
  }
  get stoppedWhileQueued(): boolean {
    return this.state.stoppedWhileQueued;
  }
  get startedAt(): number {
    return this.state.startedAt;
  }
  get completedAt(): number | undefined {
    return this.state.completedAt;
  }
  get consumedAt(): number | undefined {
    return this.state.consumedAt;
  }
  get consumed(): boolean {
    return this.state.consumed;
  }
  get claimed(): boolean {
    return this.state.claimed;
  }
  get pendingQuestion(): string | undefined {
    return this.state.pendingQuestion;
  }
  get runUpdates(): readonly string[] {
    return this.state.runUpdates;
  }
  get turnBudget(): TurnBudget | undefined {
    return this.state.turnBudget;
  }
  get toolUses(): number {
    return this.state.toolUses;
  }
  get lifetimeUsage(): Readonly<LifetimeUsage> {
    return this.state.lifetimeUsage;
  }
  get compactionCount(): number {
    return this.state.compactionCount;
  }
  get activeTools(): ReadonlyMap<string, string> {
    return this.state.activeTools;
  }
  get responseText(): string {
    return this.state.responseText;
  }
  isActive(): boolean {
    return this.state.isActive();
  }
  isTerminalError(): boolean {
    return this.state.isTerminalError();
  }
  isRunning(): boolean {
    return this.state.isRunning();
  }
  canBeSteered(): boolean {
    return this.state.canBeSteered();
  }

  /**
   * The run in flight, or the last one to start. Everything that belongs to one
   * execution lives on it and is replaced as a unit by `startRun`. Until the
   * first run starts it is that run's unstarted shell, so the cancel lever
   * always exists.
   */
  private current: Run;
  /** Cancels whichever run is current. */
  get abortController(): AbortController {
    return this.current.abort;
  }
  /** Handle on the agent's current run — the initial run, or the live resume that replaced it. */
  get promise(): Promise<void> | undefined {
    return this.current.promise;
  }

  private readonly execution: SubagentExecution;

  subagentSession?: SubagentSession;

  /**
   * What the session knew, captured when releaseSession() disposed it (or from a
   * saved entry), so the transcript pointer survives and the resume path can
   * tell "released" from "never had a session". Cleared when a session is
   * attached again.
   */
  private released?: ReleasedSessionInfo;
  /** A reopened transcript must not share its session ID with a dying session. */
  private sessionRelease?: Promise<void>;

  // Steer buffer — messages queued before the session is ready
  private _pendingSteers: string[] = [];
  /** Number of steer messages waiting to be delivered. */
  get pendingSteerCount(): number {
    return this._pendingSteers.length;
  }

  /**
   * Path to the agent's session JSONL file, or undefined if not yet available.
   * Falls back to the path captured at releaseSession() once the live session is gone.
   */
  get outputFile(): string | undefined {
    return this.subagentSession?.outputFile ?? this.released?.outputFile;
  }

  /**
   * The model this agent runs: the live session's (so a mid-run switch shows),
   * then the one captured at releaseSession(), then the spawn override.
   * Undefined for an inherited model until the session exists.
   */
  get model(): Model<any> | undefined {
    return this.subagentSession?.model ?? this.released?.model ?? this.execution.model;
  }

  /** The thinking level this agent runs at, resolved in the same order as `model`. */
  get thinkingLevel(): ThinkingLevel | undefined {
    return (
      this.subagentSession?.thinkingLevel ??
      this.released?.thinkingLevel ??
      this.execution.thinkingLevel
    );
  }

  /** The turn ceiling the spawn asked for; undefined when it left the agent's own limit. */
  get maxTurns(): number | undefined {
    return this.execution.maxTurns;
  }

  /** The directory this agent runs in: the caller's choice, or the parent's. */
  get cwd(): string {
    return this.execution.cwd ?? this.execution.snapshot.cwd;
  }

  /** The tool call ID that spawned this background agent, if any. */
  get toolCallId(): string | undefined {
    return this.execution.parentSession?.toolCallId;
  }

  /** Returns true when a SubagentSession is available (session is ready). */
  isSessionReady(): boolean {
    return this.subagentSession != null;
  }

  /**
   * Why a resume of this agent would be refused, or undefined when one would be
   * accepted.
   *
   * A live run outranks everything: nothing about a settled record is decided
   * yet. A live session is resumable. A released one is resumable if its
   * transcript can be reopened.
   *
   * A getter rather than a predicate method because the result carriers read it
   * as a field: `OutcomeAddenda` and `AgentReport` both declare it, and a live
   * record satisfies them structurally only if it is a property.
   */
  get resumeRefusal(): ResumeRefusal | undefined {
    // Before the session check: a run transitions to running before it creates
    // its session, and "still running" describes that record better than "no
    // session" does. A queued agent is not running and keeps the no-session
    // answer, which is the truth about it.
    if (this.isRunning() || this.current.reopening) return "still-running";
    if (this.isSessionReady()) return undefined;
    if (!this.released) return "no-session";
    const { checkReopen } = this.execution;
    return checkReopen ? checkReopen(this) : "session-released";
  }

  /**
   * Steer a running agent, owning the non-running rejection rule.
   * Returns a `rejected` outcome (with the observed status) when the agent is
   * not running, a `buffered` outcome when the session is not yet ready, or a
   * `delivered` outcome once the message reaches the session.
   */
  async steer(message: string): Promise<SteerOutcome> {
    if (!this.canBeSteered()) {
      return { kind: "rejected", status: this.status };
    }
    if (!this.subagentSession) {
      this._pendingSteers.push(message);
      return { kind: "buffered" };
    }
    await this.subagentSession.steer(message);
    return { kind: "delivered" };
  }

  /** Return the session conversation as formatted text, or undefined if no session. */
  getConversation(): string | undefined {
    return this.subagentSession?.getConversation();
  }

  /** Return the session context window utilization (0-100), or null if unavailable. */
  getContextPercent(): number | null {
    return this.subagentSession?.getContextPercent() ?? null;
  }

  /**
   * Subscribe to session events for live updates (e.g., conversation viewer).
   * Returns an unsubscribe function, or undefined if no session is available.
   */
  subscribeToUpdates(fn: (event: AgentSessionEvent) => void): (() => void) | undefined {
    return this.subagentSession?.subscribe(fn);
  }

  /** The session's message history typed for Pi's session-rendering machinery, or empty if no session. */
  get agentMessages(): readonly SessionMessage[] {
    return this.subagentSession?.agentMessages ?? [];
  }

  /** Resolve a registered tool definition by name, or undefined if no session. */
  getToolDefinition(name: string): ToolDefinition | undefined {
    return this.subagentSession?.getToolDefinition(name);
  }

  constructor(init: SubagentInit) {
    // Identity
    this.id = init.id;
    this.type = init.type;
    this.description = init.description;
    this.isBackground = init.isBackground;

    // Lifecycle status and metrics — fresh queued state unless one is supplied
    this.state = init.state ?? new SubagentState();

    // The first run's shell — its cancel lever exists before the run starts
    this.current = new Run({
      kind: "initial",
      prompt: init.execution.prompt,
      signal: init.execution.signal,
    });

    // Execution machinery — a single mandatory collaborator
    this.execution = init.execution;
    this.released = init.released;
  }

  /**
   * Execute the full agent lifecycle for the first run: session creation via
   * the factory, observer wiring, the turn loop, and status transitions.
   *
   * Execution is supplied at construction (mandatory), so run() needs no
   * "not configured" guards. The returned promise always resolves (errors are
   * captured internally).
   */
  run(): Promise<void> {
    return this.startRun({
      kind: "initial",
      prompt: this.execution.prompt,
      signal: this.execution.signal,
    });
  }

  /**
   * The one place a run starts. The first run and every resume mint a `Run`
   * here, make it current, and execute it; they differ only in the `kind` the
   * run carries and in whether an `admit` defers its start.
   *
   * The body runs synchronously up to its first await when not deferred, so a
   * resume has reset the record by the time its caller regains control.
   */
  private startRun(init: RunInit, admit?: Admission): Promise<void> {
    const previous = this.current;
    const turnCeiling =
      init.kind === "resume"
        ? this.turnBudget
          ? (this.turnBudget.maxTurns ?? 0)
          : previous.turnCeiling
        : undefined;
    const run = new Run({ ...init, turnCeiling });
    this.current = run;
    // Release the previous run's listener handles before wiring this one's.
    if (init.kind === "resume") previous.listeners.release();
    const body = () => this.execute(run);
    run.promise = admit ? admit(body) : body();
    return run.promise;
  }

  /** A run's whole lifecycle. Always resolves — errors terminate through fail(). */
  private async execute(run: Run): Promise<void> {
    if (!this.begin(run)) return;
    try {
      let session = run.liveSession;
      if (session) {
        this.observeSession(run, session);
      } else {
        // Only a new or reopened session awaits here, so a live resume keeps its timing.
        session = await this.openSession(run);
        run.reopening = false;
        if (!session) {
          // Stopped while the session was being rebuilt; abort() marked the record.
          this.finish(run);
          return;
        }
        this.attachSession(run, session);
      }
      this.settle(run, await this.turnLoop(run, session));
    } catch (err) {
      this.fail(run, err);
    }
  }

  /**
   * Record that the run is under way. False when an initial run's agent left the
   * active set before its slot opened (e.g. abort-while-queued): that run does
   * nothing.
   */
  private begin(run: Run): boolean {
    if (run.kind === "initial") {
      if (!this.isActive()) return false;
      this.state.markRunning(Date.now());
      this.execution.observer?.onStarted?.(this);
      run.listeners.wireSignal(run.signal, () => this.abort());
      return true;
    }
    this.state.resetForResume(Date.now());
    run.listeners.wireSignal(run.signal, () => this.abort());
    this.execution.observer?.onResumeStarted?.(this);
    return true;
  }

  /** What every session this agent creates shares, new or reopened. */
  private sessionParams(runConfig: RunConfig | undefined): CreateSubagentSessionParams {
    return {
      snapshot: this.execution.snapshot,
      agentConfig: this.execution.agentConfig,
      type: this.type,
      parentSession: this.execution.parentSession,
      agentId: this.id,
      cwd: this.cwd,
      ...(this.execution.handoff ? { handoff: this.execution.handoff } : {}),
      askParent: (question) => {
        this.state.setPendingQuestion(question);
      },
      // The operator's setting is the whole gate (on when no run config is
      // supplied): where an update lands is decided per message, not per child.
      notifyParent:
        (runConfig?.midRunUpdates ?? true)
          ? (message) => {
              this.announceUpdate(message);
            }
          : undefined,
    };
  }

  /** The session a run drives: a new one for the initial run, a rebuilt one for a cold resume. */
  private openSession(run: Run): Promise<SubagentSession | undefined> {
    return run.kind === "initial" ? this.createSession(run) : this.reopenSession(run);
  }

  /**
   * Create the initial run's session. Not async, so the run awaits the factory's
   * own promise.
   */
  private createSession(run: Run): Promise<SubagentSession> {
    run.runConfig = this.execution.getRunConfig?.();
    return this.execution.createSubagentSession({
      ...this.sessionParams(run.runConfig),
      model: this.execution.model,
      thinkingLevel: this.execution.thinkingLevel,
    });
  }

  /** Drive the turn loop: the initial run starts it, a resume continues it. */
  private turnLoop(run: Run, session: SubagentSession): Promise<TurnLoopResult> {
    if (run.kind === "resume") {
      return session.resumeTurnLoop(run.prompt, this.turnLoopOptions(run));
    }
    return session.runTurnLoop(run.prompt, {
      maxTurns: this.execution.maxTurns,
      defaultMaxTurns: run.runConfig?.defaultMaxTurns,
      wrapUpTurns: run.runConfig?.wrapUpTurns,
      ...this.turnLoopOptions(run),
    });
  }

  /** What every turn loop this agent drives shares, initial or resumed. */
  private turnLoopOptions(run: Run): {
    signal: AbortSignal;
    onTurnBudget: (budget: TurnBudget) => void;
  } {
    return {
      signal: run.abort.signal,
      onTurnBudget: (budget) => {
        this.state.setTurnBudget(budget);
      },
    };
  }

  /** Adopt a new or reopened session: deliver buffered steers, observe it, announce it. */
  private attachSession(run: Run, session: SubagentSession): void {
    this.subagentSession = session;
    this.released = undefined;
    this.flushPendingSteers();
    this.observeSession(run, session);
    this.execution.observer?.onSessionCreated?.(this);
  }

  private observeSession(run: Run, session: SubagentSession): void {
    run.listeners.attachObserver(
      subscribeSubagentObserver(session, this.state, {
        onCompact: (info) => this.execution.observer?.onCompacted?.(this, info),
      }),
    );
  }

  /**
   * Record an update the child sent, then offer it to the announcement channel.
   *
   * Every update joins the run's ledger, whoever ends up delivering it: this
   * side cannot know whether an announcement will reach the parent in time, or
   * at all, so it records unconditionally and lets the channel that delivers
   * mark what it took. What the ledger still owes is what an outcome carrier
   * renders alongside the result.
   */
  private announceUpdate(message: string): void {
    this.state.recordUpdate(message);
    this.execution.observer?.onUpdateSent?.(this, message);
  }

  /**
   * Start the first run immediately (bypassQueue paths).
   * The run promise is awaitable via the `promise` getter.
   */
  start(): void {
    void this.run();
  }

  /**
   * Schedule the first run through an external concurrency scheduler (the
   * limiter). The scheduler's promise is captured eagerly, so a still-queued
   * agent is awaitable via the `promise` getter from spawn — not only once its
   * slot opens. The guard in begin() makes an abort-while-queued run a no-op
   * when the slot finally frees.
   */
  scheduleVia(schedule: Admission): void {
    void this.startRun(
      { kind: "initial", prompt: this.execution.prompt, signal: this.execution.signal },
      schedule,
    );
  }

  /**
   * Wait until this agent's current run settles.
   * Resolves immediately when the agent is no longer active or has no run
   * handle. A queued agent is awaitable because scheduleVia() captures the
   * limiter promise at spawn, so the wait spans both the queue slot and the
   * run that follows it.
   *
   * When `signal` fires the wait ends early and the agent keeps running: this
   * is a query, so interrupting it must not cancel the work. Cancelling the
   * work on a parent interrupt is InterruptHandler's separate decision.
   *
   * Reports what happened to the run the wait began on. A resume can start
   * between that run settling and the waiter continuing (a consumer resuming
   * from the completion event does), so a record that reads active afterwards
   * is not necessarily the run that was waited on.
   */
  async waitUntilSettled(signal: AbortSignal): Promise<WaitOutcome> {
    const waitedRun = this.state.run;
    const handle = this.promise;
    if (handle && this.isActive()) await settleOrAbort(handle, signal);
    const superseded =
      this.state.run === waitedRun ? undefined : this.state.supersededOutcome(waitedRun);
    if (superseded) return { kind: "superseded", outcome: superseded };
    return this.isActive() ? { kind: "unsettled" } : { kind: "settled" };
  }

  /**
   * Resume the session with a new prompt: the live SubagentSession, or a
   * released one whose transcript can be reopened (`resumeRefusal` is the
   * check). The returned promise always resolves (errors are captured
   * internally) and is published as the `promise` getter, so waiters track the
   * resume rather than the settled handle of the original run.
   *
   * A resume runs under its own controller, like the initial run: the
   * controller belongs to the run, so a record aborted on its original run does
   * not resume under a spent one. A caller's `signal` is wired to abort() rather
   * than forwarded to the turn loop, so both levers stop the same run and both
   * leave the record reading `stopped`.
   *
   * A resume is admitted at once: it does not go through the limiter.
   */
  resume(prompt: string, signal?: AbortSignal): Promise<void> {
    const liveSession = this.subagentSession;
    if (!liveSession && !(this.released && this.resumeRefusal === undefined)) {
      // Rejection, not a throw: this method is not async, and a synchronous
      // throw would escape a caller's `.rejects` assertion.
      return Promise.reject(new Error("Subagent not configured for resume — missing session"));
    }
    return this.startRun({ kind: "resume", prompt, signal, liveSession });
  }

  /**
   * Build a new session around the saved transcript, with what this agent last
   * ran on. Its limits are set here because no initial run will set them.
   *
   * Undefined when the agent was stopped meanwhile. That also covers a parent
   * shutdown, which has already torn down every session it could see, so the new
   * one is disposed rather than kept.
   */
  private async reopenSession(run: Run): Promise<SubagentSession | undefined> {
    if (this.sessionRelease) await this.sessionRelease;
    if (run.abort.signal.aborted) return undefined;
    const runConfig = this.execution.getRunConfig?.();
    const session = await this.execution.createSubagentSession({
      ...this.sessionParams(runConfig),
      ...(this.outputFile !== undefined ? { transcriptPath: this.outputFile } : {}),
      model: this.model,
      thinkingLevel: this.thinkingLevel,
    });
    if (run.abort.signal.aborted) {
      await disposeQuietly(session, "stopped cold resume");
      return undefined;
    }
    session.applyTurnLimits({
      maxTurns: run.turnCeiling ?? this.execution.maxTurns,
      defaultMaxTurns: runConfig?.defaultMaxTurns,
      wrapUpTurns: runConfig?.wrapUpTurns,
    });
    return session;
  }

  /**
   * The turn loop returned. The harness ending it at its turn limit is the one
   * way a returned run is not complete: that ends the run for good, as aborted.
   */
  private settle(run: Run, result: TurnLoopResult): void {
    if (result.turnBudget.phase === "exhausted") this.state.markAborted(result.responseText);
    else this.state.markCompleted(result.responseText);
    this.finish(run);
  }

  /**
   * The run failed. A question the child recorded is dropped: every carrier
   * renders a pending question as "answer by resuming me", which is not the
   * right next action after a failure, and the failure text already tells the
   * parent to look.
   */
  private fail(run: Run, err: unknown): void {
    run.reopening = false;
    this.state.markError(err);
    this.state.setPendingQuestion(undefined);
    this.finish(run);
  }

  /** Release the run's listeners and report its terminal transition. */
  private finish(run: Run): void {
    run.listeners.release();
    if (run.kind === "resume") this.execution.observer?.onResumeFinished?.(this);
    else this.execution.observer?.onRunFinished?.(this);
  }

  /** Record the parent collected this agent's outcome. Idempotent. */
  markConsumed(at?: number): void {
    this.state.markConsumed(at);
  }

  /** The announcement channel delivered this update; no outcome carrier repeats it. */
  markUpdateAnnounced(message: string): void {
    this.state.markUpdateAnnounced(message);
  }

  /**
   * A carrier has committed to delivering this outcome; nothing else announces
   * it. The returned handle lets a carrier that abandons its commitment (a
   * waiter whose parent turn was interrupted) drop only its own.
   */
  claim(): CarrierClaim {
    return this.state.claim();
  }

  /**
   * No carrier holds this outcome; announcing is owed again. Called when a
   * resume nobody claims starts (SubagentManager.startResume), clearing the
   * claims previous carriers left after they delivered.
   */
  releaseClaims(): void {
    this.state.releaseClaims();
  }

  /**
   * Stop the agent: a queued one through the same terminal funnel a run's stop
   * uses, a running one by firing its current run's AbortController. Each run
   * has its own controller, so the lever always reaches whichever run is in
   * flight. A stopped queued agent leaves the active set, so its scheduled
   * thunk no-ops on begin()'s guard when its slot frees. Returns false when there was nothing to stop.
   */
  abort(): boolean {
    if (this.status === "queued") {
      this.state.stopQueued();
      this.execution.observer?.onRunFinished?.(this);
      return true;
    }
    if (!this.isRunning()) return false;
    this.current.abort.abort();
    this.state.markStopped();
    return true;
  }

  /**
   * Flush all buffered steer messages to the session and clear the buffer.
   * Called once the session is available.
   */
  private flushPendingSteers(): void {
    for (const msg of this._pendingSteers) {
      this.subagentSession?.steer(msg).catch(() => {});
    }
    this._pendingSteers = [];
  }

  /**
   * Dispose the wrapped session, firing the `disposed` lifecycle event.
   * Resolves once the child's extensions have shut down; a failing teardown is
   * swallowed so the caller's remaining cleanup still runs.
   */
  async disposeSession(): Promise<void> {
    await disposeQuietly(this.subagentSession, "child session dispose");
    // A retention release already cleared subagentSession, but its shutdown
    // must finish before a reload can reopen the same transcript/session ID.
    await this.sessionRelease;
  }

  /**
   * Release the heavy session while keeping the record: capture the transcript
   * pointer, dispose the session (firing `disposed`), clear it, and mark released.
   * A no-op once the session is gone — the retention sweep may call it repeatedly.
   *
   * The record's own state is updated before the teardown is awaited, so a sweep
   * tick arriving mid-teardown sees a released record rather than starting a
   * second one.
   */
  async releaseSession(): Promise<void> {
    const session = this.subagentSession;
    if (!session) return;
    this.released = {
      outputFile: session.outputFile,
      model: session.model,
      thinkingLevel: session.thinkingLevel,
    };
    this.subagentSession = undefined;
    this.sessionRelease = disposeQuietly(session, "child session release");
    await this.sessionRelease;
    this.sessionRelease = undefined;
  }
}

/**
 * Tear a child session down without letting its failure escape.
 * Both teardown paths are cleanup: a child that will not shut down cleanly must
 * not stop the caller from finishing the rest of its own cleanup.
 */
async function disposeQuietly(
  session: SubagentSession | undefined,
  context: string,
): Promise<void> {
  try {
    await session?.dispose();
  } catch (err) {
    debugLog(context, err);
  }
}

/**
 * Settle with `run`, or early when `signal` fires — whichever comes first.
 * The inner controller is the listener-cleanup channel: it detaches the abort
 * listener whichever branch wins, so repeated waits within one parent turn do
 * not accumulate listeners on that turn's signal.
 */
function settleOrAbort(run: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const detach = new AbortController();
  const interrupted = new Promise<void>((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true, signal: detach.signal },
    );
  });
  return Promise.race([run, interrupted]).finally(() => {
    detach.abort();
  });
}
