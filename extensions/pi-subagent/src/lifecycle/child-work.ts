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
 * Because a message is in the transcript when `send` returns, the host closes an item as soon as
 * it is completed (`confirmLanding` off). Landing confirmation for a message Pi holds mid-run is
 * the next step (9b).
 *
 * The agent derives "waiting" from `openItems()`: an idle agent with open items is waiting, one
 * without is done. Nothing about waiting is stored.
 */
import { debugLog } from "#src/debug";
import { provide } from "../../../../packages/pi-session-tree/src/index.ts";
import {
  createWorkHost,
  WORK_ENTRY,
  WORK_SERVICE,
  type Completion,
  type SendMode,
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
  subscribe(listener: (event: { type: string }) => void): () => void;
}

/** The slice of `SessionManager` that persists open items. */
export interface ChildWorkStore {
  getBranch(): readonly { type: string; customType?: string; data?: unknown }[];
  appendCustomEntry(customType: string, data?: unknown): string;
}

export interface ChildWorkParams {
  /** The child's session id: the host is offered under it. */
  sessionId: string;
  session: ChildWorkSession;
  store: ChildWorkStore;
  policy: ChildWorkPolicy;
}

/** One child session's host, offered to its extensions, and what the agent reads from it. */
export class ChildWork {
  /** The host, as providers and producers see it. */
  readonly host: WorkHostRuntime;
  private readonly withdraw: () => void;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(params: ChildWorkParams) {
    const { session, store, policy } = params;
    this.host = createWorkHost({
      store: {
        read: () =>
          store
            .getBranch()
            .filter((entry) => entry.type === "custom" && entry.customType === WORK_ENTRY)
            .map((entry) => entry.data),
        append: (record: WorkRecord) => void store.appendCustomEntry(WORK_ENTRY, record),
      },
      delivery: {
        isIdle: () => session.isIdle,
        send: (items, mode) => this.send(session, policy, items, mode),
        lost: (items) =>
          debugLog(
            "child work host",
            new Error(`${items.length} work message(s) not delivered: the session is gone`),
          ),
      },
      onChange: () => policy.changed(),
    });
    // The session reports its own run boundaries, so `Delivery` knows whether a run is active
    // without any extension of the child wiring them.
    this.unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_start") this.host.agentStart();
      else if (event.type === "agent_settled") this.host.agentSettled();
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
    if (!this.disposed) this.host.settleStartup();
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
   * The session is going away. Open items stay persisted in the child's transcript: if the child
   * is ever reopened they are reported lost to it, which is accurate, because whatever they
   * stood for died with the session.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
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
    if (mode === "wake") policy.wake();
  }
}
