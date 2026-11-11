/**
 * child-work.ts - the managed work host of one child session (roadmap step 9a).
 *
 * Every session has a work host (`work:v1`, packages/pi-work). The root session's is provided by
 * `ensureWorkHost` and wakes the session with `sendMessage`. A child's is provided here, under
 * the child's session id, before its extensions bind, so `ensureWorkHost` in the child finds it
 * and provides nothing. What differs from the root is only who wakes the session:
 *
 *  - `store`: the child's own session file. Open items are custom entries written straight to the
 *    child's `SessionManager`.
 *  - delivery: a message is written into the child's transcript at once (`sendCustomMessage`
 *    with `triggerTurn: false`): appended now while the child is idle, held by Pi until the end
 *    of the turn while it runs. The transcript is the inbox. For an idle child the host then asks
 *    the agent for a run (`ChildWorkPolicy.wake`), which the manager queues through the
 *    concurrency limiter. No message ever starts a run by itself, so no run escapes the limiter
 *    or the turn budget.
 *
 * A message Pi holds mid-run is appended at the end of the turn, so the host closes a completed
 * item only once its message is in the transcript (`confirmLanding`): a crash in between leaves the
 * item open and the next start reports it lost. pi-work's `LandingTracker` reads the child's
 * transcript for that, fed by the session's own events. It is the only reader: the inline
 * extension of the child (`ensureWorkHost`) forwards run boundaries and reads no landing.
 *
 * A message that reaches the transcript after the run's last chance to continue (between its
 * final `agent_before_settle` and `agent_settled`) has no continuation to answer it and finds no
 * idle session to wake. At `agent_settled` the host reads the transcript tail and, when a work
 * message is still unanswered, asks the agent for a run.
 *
 * The agent derives "waiting" from `openItems()`: an idle agent with open items is waiting, one
 * without is done. Nothing about waiting is stored.
 */
import { customData } from "../../../../packages/pi-session-state/src/index.ts";
import { debugLog } from "#src/debug";
import { provide } from "../../../../packages/pi-session-tree/src/index.ts";
import {
  createLandingTracker,
  createWorkHost,
  QUESTION_KIND,
  WORK_ENTRY,
  WORK_SERVICE,
  type Completion,
  type LandingTracker,
  type SendMode,
  type TranscriptEntry,
  type WorkHostRuntime,
  type WorkItemView,
  type WorkMessage,
  type WorkRecord,
} from "../../../../packages/pi-work/src/index.ts";

/** What the host asks of the agent whose session it serves. */
export interface ChildWorkPolicy {
  /**
   * A message reached an idle session: ask for a run that answers it. The message is already in
   * the transcript. The agent decides how: through the limiter, never at once, and not at all
   * when a run is already queued or running (that run sees the message).
   */
  wake(): void;
  /** The set of open items changed (opened, completed, cancelled or lost). */
  changed(): void;
  /**
   * Once per startup, the items nobody took over: closed as lost, with the message already in
   * the transcript. For whoever reports a restart's losses to the agent's parent (step 12).
   */
  lost?(items: readonly WorkItemView[]): void;
}

/** The slice of `AgentSession` the host writes through and listens to. */
export interface ChildWorkSession {
  /** No agent run, compaction, branch summary, retry or queued continuation. */
  readonly isIdle: boolean;
  sendCustomMessage(
    message: {
      customType: string;
      content: WorkMessage["content"];
      display: boolean;
      details?: unknown;
    },
    options: { triggerTurn: boolean },
  ): Promise<void>;
  /** `agent_settled` carries `aborted`: the run was stopped. */
  subscribe(listener: (event: { type: string; aborted?: boolean }) => void): () => void;
}

/** The slice of `SessionManager` that persists open items. */
export interface ChildWorkStore {
  getBranch(): readonly (TranscriptEntry & { data?: unknown })[];
  appendCustomEntry(customType: string, data?: unknown): string;
}

export interface ChildWorkParams {
  /** The child's session id: the host is offered under it. */
  sessionId: string;
  session: ChildWorkSession;
  store: ChildWorkStore;
  policy: ChildWorkPolicy;
  /**
   * Whether this host's creation was abandoned (a reopen that took too long and was given up on):
   * the transcript belongs to a newer session by now, so the host writes nothing to it. Opening
   * an item throws, a message is refused (its item stays open), and startup is not settled.
   */
  isStale?: () => boolean;
}

/** One child session's host, offered to its extensions, and what the agent reads from it. */
export class ChildWork {
  /** The host, as providers and producers see it. */
  readonly host: WorkHostRuntime;
  private readonly withdraw: () => void;
  private readonly unsubscribe: () => void;
  private readonly landing: LandingTracker;
  private disposed = false;
  private readonly stale: () => boolean;

  constructor(params: ChildWorkParams) {
    const { session, store, policy } = params;
    const stale = () => params.isStale?.() === true;
    this.stale = stale;
    this.landing = createLandingTracker({
      branch: () => store.getBranch(),
      target: () => this.host,
    });
    this.host = createWorkHost({
      store: {
        read: () => customData(store.getBranch(), WORK_ENTRY),
        append: (record: WorkRecord) => {
          if (stale()) throw new Error("the child session is stale: its transcript is not its own");
          void store.appendCustomEntry(WORK_ENTRY, record);
        },
      },
      delivery: {
        isIdle: () => session.isIdle,
        send: (items, mode) => {
          if (stale()) throw new Error("the child session is stale: its transcript is not its own");
          this.send(session, policy, items, mode);
        },
        lost: (items) =>
          debugLog(
            "child work host",
            new Error(`${items.length} work message(s) not delivered: the session is gone`),
          ),
      },
      // Pi holds a message sent mid-run until the turn ends: close the item once it is written.
      confirmLanding: true,
      landingMark: () => this.landing.mark(),
      onChange: () => policy.changed(),
      onLost: (items) => policy.lost?.(items),
    });
    // The session reports its own run boundaries, so `Delivery` knows whether a run is active and
    // the landing tracker knows when a held message may have been appended, without any
    // extension of the child wiring them.
    this.unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_start") {
        this.host.agentStart();
      } else if (event.type === "agent_settled") {
        this.settled(policy, event.aborted === true);
      } else if (
        event.type === "message_end" ||
        event.type === "turn_start" ||
        event.type === "agent_end"
      ) {
        this.landing.observe(event.type);
      }
    });
    this.host.start();
    // Before the child's extensions bind, so each finds it on `session_start`.
    this.withdraw = provide(params.sessionId, WORK_SERVICE, this.host);
  }

  /**
   * Every extension of the child has had its `session_start`: close what nobody adopted as lost.
   * The lost message is recorded in the transcript without starting a run.
   */
  settleStartup(): void {
    if (!this.disposed && !this.stale()) this.host.settleStartup();
  }

  /**
   * The run is over, including its continuations, and Pi has appended every message it held.
   * Close what landed, then answer a message that arrived too late for the run to continue: no
   * boundary is left in this run to answer it, and the session counted as busy when it arrived, so
   * nothing woke it. A stopped run answers nothing (the message waits for the next run).
   */
  private settled(policy: ChildWorkPolicy, aborted: boolean): void {
    this.landing.observe("agent_settled");
    this.host.agentSettled();
    if (!aborted && this.landing.unanswered((customType) => this.host.delivers(customType)))
      policy.wake();
  }

  /** The child's open items, oldest first. */
  openItems(): readonly WorkItemView[] {
    return this.disposed ? [] : this.host.list();
  }

  /**
   * The agent was stopped: call off what it waits on. Every open item closes as cancelled, so a
   * reopened agent is not told about work its parent deliberately stopped. (An agent whose run
   * failed keeps its items open instead, so a reopened one hears they were lost.)
   */
  cancelOpen(): number {
    return this.disposed ? 0 : this.host.cancelOpen();
  }

  /**
   * Tell the child that `items`, just called off, did not finish: one message in its own
   * transcript (appended at once, no run started, nothing woken). Without it the child's context
   * still holds what started the work ("you will be woken") and nothing says it was killed. Call
   * it before the session is released, while it can still take the message.
   */
  reportCalledOff(items: readonly WorkItemView[]): void {
    if (!this.disposed) this.host.reportCalledOff(items);
  }

  /**
   * The delegator answered the child: close the question items it waits on, as cancelled (the
   * answer reaches the child as the run's prompt, not as a work message), and leave every other
   * item open. Returns how many were closed.
   */
  answerQuestions(): number {
    return this.disposed ? 0 : this.host.cancelOpen((item) => item.kind === QUESTION_KIND);
  }

  /**
   * The session is going away. Retention never gets here with an item open (an agent with open
   * work keeps its session, and a stop, a failure or the turn limit call the work off first), so
   * what can still be open is the work of a session whose process is shutting down or dying. Those
   * items stay persisted in the child's transcript: if the child is ever reopened they are adopted
   * by their owner or reported lost to it, which is accurate, because whatever they stood for died
   * with the session.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.landing.check(); // a message already in the transcript closes its item before the host goes
    this.landing.dispose();
    this.host.dispose();
    this.withdraw();
  }

  private send(
    session: ChildWorkSession,
    policy: ChildWorkPolicy,
    items: Completion<WorkMessage>[],
    mode: SendMode,
  ): void {
    if (this.disposed) throw new Error("the child session is gone");
    for (const { payload } of items) {
      const { customType, content, details } = payload;
      // Not a trigger: appended now when the child is idle, at the end of the turn while it runs.
      // Idle, the append is synchronous, so the message is in the transcript when this returns.
      void session
        .sendCustomMessage(
          { customType, content, display: true, ...(details !== undefined ? { details } : {}) },
          { triggerTurn: false },
        )
        .catch((error: unknown) => debugLog("child work message", error));
    }
    // Pi appends at once when it is neither streaming nor starting a run for it.
    this.landing.sent();
    if (mode === "wake") policy.wake();
  }
}
