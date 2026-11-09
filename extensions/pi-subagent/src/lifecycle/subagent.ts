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
import { type Admission, joinPrompt, Run, type RunInit } from "#src/lifecycle/run";
import type { SubagentSession, TurnLoopResult } from "#src/lifecycle/subagent-session";
import {
  type DisplayStatus,
  type RunOutcome,
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
  /**
   * Fires when a resume had to wait for a concurrency slot: the agent is queued
   * again and nothing has started. A resume admitted at once never fires it.
   */
  onResumeQueued?(agent: Subagent): void;
  /** Fires once when a resumed run reaches a terminal state. */
  onResumeFinished?(agent: Subagent): void;
  /** Fires when the running agent sends its parent a mid-run message. */
  onUpdateSent?(agent: Subagent, message: string): void;
  /** Fires on compaction events during the run. */
  onCompacted?(agent: Subagent, info: CompactionInfo): void;
}

export type { DisplayStatus, RunOutcome, SubagentStatus } from "#src/lifecycle/subagent-state";

/**
 * Why an idle agent cannot take a message. A running or queued agent always
 * takes one.
 *
 * `rebuilding` is the one transient member, a refusal of *now* rather than of
 * ever: the agent was stopped while its transcript was being reopened, and that
 * stopped rebuild still owns the transcript until it winds down. A second
 * session on it would write the same file.
 *
 * `no-session` is an agent that never got a session and whose original task is
 * not at hand to start one with: only a saved record of it survives.
 */
export type SendRefusal = "rebuilding" | "no-session" | ReopenRefusal;

/**
 * What `Subagent.send` did with a message, by the state it found the agent in.
 * `Subagent.send` owns the state rule and reports it here, so coordinators
 * switch on the outcome instead of pre-checking status (tell by id, with
 * outcomes).
 *
 * - `steered`: the agent was running. The message went to its session
 *   (`delivered`), or is held until the session exists (`buffered`).
 * - `joined`: the agent was queued for a slot. The message was added to the
 *   prompt of the run that is waiting, which sees it when it starts.
 * - `started`: the agent was idle and a run was requested with the message as
 *   its prompt. It begins now, or waits for a slot (the record reads `queued`).
 *   `relaunched` marks the first run of an agent that never had a session.
 * - `refused`: the agent is idle and cannot take the message.
 */
export type SendOutcome =
  | { kind: "steered"; delivery: "delivered" | "buffered" }
  | { kind: "joined" }
  | { kind: "started"; relaunched: boolean }
  | { kind: "refused"; reason: SendRefusal };

/**
 * The execution machinery a Subagent needs to run. A single mandatory
 * collaborator: production (SubagentManager.spawn) always supplies it, so run()
 * needs no "not configured" guards. The genuinely-optional behavior knobs stay
 * optional; the four inputs run() cannot proceed without are required.
 */
export interface SubagentExecution {
  /** Assembly factory that produces a born-complete SubagentSession. */
  createSubagentSession: (params: CreateSubagentSessionParams) => Promise<SubagentSession>;
  /**
   * How a resume is admitted: the limiter, in production. Every run goes through
   * it, the first run (`scheduleVia`) and every resume alike. Absent, a resume
   * begins at once, which only a bare `Subagent` built without a manager does.
   */
  admit?: Admission;
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

  // Lifecycle status and metrics — owned by a private value object; getters and
  // mutation methods below delegate to it one line.
  private readonly state: SubagentState;
  get status(): SubagentStatus {
    return this.state.status;
  }
  /** How the last run ended; undefined while a run is queued or running. */
  get outcome(): RunOutcome | undefined {
    return this.state.outcome;
  }
  /**
   * The label users and subscribers see: `completed`, `aborted`, `stopped` or
   * `error` once idle, else the status itself.
   */
  get displayStatus(): DisplayStatus {
    return this.state.displayStatus;
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
   * Why a message to this agent would be refused, or undefined when it would be
   * accepted.
   *
   * A running agent is steered and a queued one takes the message into its
   * waiting run, so only an idle agent can refuse. A live session takes the next
   * run. A released one does if its transcript can be reopened. One that never
   * had a session does if its original task is at hand: a relaunch starts its
   * first run from it.
   *
   * A getter rather than a predicate method because the reports read it
   * as a field: `OutcomeAddenda` and `AgentReport` both declare it, and a live
   * record satisfies them structurally only if it is a property.
   */
  get sendRefusal(): SendRefusal | undefined {
    if (this.isActive()) return undefined;
    if (this.current.opening) return "rebuilding";
    if (this.isSessionReady()) return undefined;
    if (!this.released) return this.execution.prompt ? undefined : "no-session";
    const { checkReopen } = this.execution;
    return checkReopen ? checkReopen(this) : "session-released";
  }

  /**
   * Give the agent a message, whatever state it is in (see `SendOutcome`).
   *
   * Like typing into a main session: a running agent is steered, and an idle one
   * starts a run with the message as its prompt, reopening its transcript if its
   * session was released, however long ago it finished. An idle agent that never
   * had a session gets its first run, from its original task followed by the
   * message.
   *
   * Idle agents go through the limiter like any run. `signal` is a caller's
   * lever on a run this call starts.
   */
  async send(message: string, signal?: AbortSignal): Promise<SendOutcome> {
    if (this.isRunning()) {
      if (!this.subagentSession) {
        this._pendingSteers.push(message);
        return { kind: "steered", delivery: "buffered" };
      }
      await this.subagentSession.steer(message);
      return { kind: "steered", delivery: "delivered" };
    }
    if (this.status === "queued") {
      this.current.addMessage(message);
      return { kind: "joined" };
    }
    const reason = this.sendRefusal;
    if (reason) return { kind: "refused", reason };
    const relaunched = !this.isSessionReady() && !this.released;
    void (relaunched ? this.relaunch(message) : this.resume(message, signal));
    return { kind: "started", relaunched };
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
   * The one place a run starts. The first run, every resume and a relaunch mint
   * a `Run` here, make it current, and execute it; they differ only in the
   * `kind` the run carries and in whether an `admit` defers its start.
   *
   * A later run queues the record the moment it is asked for, as a first run is
   * queued when its agent is created, and the run begins when `admit` grants a
   * slot. The body runs synchronously up to its first await when the slot is
   * free, so such a run has reset the record by the time its caller regains
   * control.
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
    // Every run after the agent's first is queued the moment it is asked for.
    const again = init.kind !== "initial";
    if (again) {
      // Release the previous run's listener handles before wiring this one's.
      previous.listeners.release();
      this.state.markQueued(Date.now());
    }
    const body = () => this.execute(run);
    run.promise = admit ? admit(body) : body();
    // Still queued after admission: the limiter had no slot, so nothing has
    // started and observers learn that the agent went back to waiting.
    if (again && this.current === run && this.status === "queued") {
      this.execution.observer?.onResumeQueued?.(this);
    }
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
        run.opening = true;
        session = await this.openSession(run);
        if (session && (run.abort.signal.aborted || this.current !== run)) {
          // Stopped while the session was being created: nothing will drive it, and a
          // second session for this agent may only start once this one is gone.
          await disposeQuietly(session, "stopped session creation");
          session = undefined;
        }
        run.opening = false;
        if (!session) {
          // Stopped while the session was being built; abort() marked the record.
          this.discardPendingSteers(run);
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
   * Record that the run is under way. False when the run's turn never came: its
   * agent left the active set before the slot opened (abort-while-queued), or a
   * later run replaced it. That run does nothing.
   */
  private begin(run: Run): boolean {
    if (this.current !== run || !this.isActive()) return false;
    this.state.markRunning(Date.now());
    run.listeners.wireSignal(run.signal, () => this.abort());
    if (run.kind === "initial") this.execution.observer?.onStarted?.(this);
    else this.execution.observer?.onResumeStarted?.(this);
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

  /** The session a run drives: a new one for a first run, a rebuilt one for a cold resume. */
  private openSession(run: Run): Promise<SubagentSession | undefined> {
    return run.kind === "resume" ? this.reopenSession(run) : this.createSession(run);
  }

  /**
   * Create a first run's session. Not async, so the run awaits the factory's
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

  /** Drive the turn loop: a first run starts it, a resume continues it. */
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
   * mark what it took. What the ledger still owes is what the completion
   * message renders alongside the result.
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
   * Resume the session with a new prompt: the live SubagentSession, or a
   * released one whose transcript can be reopened (`sendRefusal` is the
   * check). The returned promise always resolves (errors are captured
   * internally) and is published as the `promise` getter, so it tracks the
   * resume rather than the settled handle of the original run.
   *
   * A resume runs under its own controller, like the initial run: the
   * controller belongs to the run, so a record aborted on its original run does
   * not resume under a spent one. A caller's `signal` is wired to abort() rather
   * than forwarded to the turn loop, so both levers stop the same run and both
   * leave the record reading `stopped`.
   *
   * A resume is admitted like a first run: it queues the record and goes
   * through the limiter, so it waits for a slot when the limit is reached.
   */
  resume(prompt: string, signal?: AbortSignal): Promise<void> {
    const liveSession = this.subagentSession;
    if (!liveSession && !(this.released && this.sendRefusal === undefined)) {
      // Rejection, not a throw: this method is not async, and a synchronous
      // throw would escape a caller's `.rejects` assertion.
      return Promise.reject(new Error("Subagent not configured for resume — missing session"));
    }
    return this.startRun({ kind: "resume", prompt, signal, liveSession }, this.execution.admit);
  }

  /**
   * Start the first run of an agent that never got a session: it was stopped
   * while queued, or its session could not be created. The run creates the
   * session from the agent's original spawn configuration and starts it from the
   * original task followed by `message`, so the agent does the work it was given
   * with what the parent has since said. It is announced as a resume (the agent
   * already has a record) and admitted through the limiter like any later run.
   * Callers check `sendRefusal` first.
   */
  private relaunch(message: string): Promise<void> {
    return this.startRun(
      { kind: "relaunch", prompt: joinPrompt(this.execution.prompt, message) },
      this.execution.admit,
    );
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
    if (this.current === run) {
      if (result.turnBudget.phase === "exhausted") this.state.markTurnLimit(result.responseText);
      else this.state.markCompleted(result.responseText);
    }
    this.finish(run);
  }

  /**
   * The run failed. A question the child recorded is dropped: every carrier
   * renders a pending question as "answer by resuming me", which is not the
   * right next action after a failure, and the failure text already tells the
   * parent to look.
   */
  private fail(run: Run, err: unknown): void {
    run.opening = false;
    this.discardPendingSteers(run);
    if (this.current === run) {
      this.state.markError(err);
      this.state.setPendingQuestion(undefined);
    }
    this.finish(run);
  }

  /**
   * Release the run's listeners and report its terminal transition. A run that
   * a later one has replaced (it was stopped, and the agent has since taken new
   * input) winds down quietly: the record now belongs to the later run, which
   * reports for itself.
   */
  private finish(run: Run): void {
    run.listeners.release();
    if (this.current !== run) return;
    if (run.kind !== "initial") this.execution.observer?.onResumeFinished?.(this);
    else this.execution.observer?.onRunFinished?.(this);
  }

  /**
   * Record the parent read this agent's finished result with `subagent_get`.
   * Idempotent. Only the retention window reads it.
   */
  markConsumed(at?: number): void {
    this.state.markConsumed(at);
  }

  /** The announcement channel delivered this update; the completion message does not repeat it. */
  markUpdateAnnounced(message: string): void {
    this.state.markUpdateAnnounced(message);
  }

  /**
   * Stop the agent: the run ends and the agent is idle with outcome `stopped`.
   * A queued run goes through the same terminal funnel a run's stop uses, a
   * running one by firing its current run's AbortController. Each run has its
   * own controller, so the lever always reaches whichever run is in flight. A
   * stopped queued agent leaves the active set, so its scheduled thunk no-ops
   * on begin()'s guard when its slot frees. Returns false when there was
   * nothing to stop. Stopping cancels nothing else: an idle agent takes a new
   * run at once.
   */
  abort(): boolean {
    if (this.status === "queued") {
      this.state.stopQueued();
      this.finish(this.current);
      return true;
    }
    if (!this.isRunning()) return false;
    this.current.abort.abort();
    this.state.markStopped();
    return true;
  }

  /**
   * Drop the steers buffered for a run that ended without a session to give them
   * to. They were addressed to that run; flushed later they would reach the next
   * run's session as if the parent had just sent them.
   */
  private discardPendingSteers(run: Run): void {
    if (this.current === run) this._pendingSteers = [];
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
