/**
 * Message delivery through Pi's own run boundaries (no timers, no polling, no queue of ours).
 *
 * Moved here from pi-job's delivery (step 2 of the work roadmap) so every producer shares one
 * mechanism. A delivered message is a custom message in the session transcript, so the
 * transcript is the inbox and nothing a user does can lose it. Two paths, both `pi.sendMessage`:
 *  - Idle: `triggerTurn: true`. Pi starts a run with the message as its trigger.
 *  - A run is active (agent_start ... agent_settled), or Pi is busy without one (compaction,
 *    branch summary): `triggerTurn: false`. Pi appends the message at the end of the current turn
 *    (immediately when it is not streaming), never between a tool call and its result, so the
 *    model sees it in the same run when another turn follows. When none does, the
 *    `agent_before_settle` handler (`continuesRun`) asks Pi for one more request. After Escape or
 *    abort the message stays in the transcript and no turn is forced; the next run sees it.
 *
 * What this does not do: wake an idle session that was busy without a run (a manual `/compact`
 * or `/tree`) when the message arrived. The message is in the transcript, and the next run
 * answers it. Pi-side races on the idle path are documented in pi-job's UPSTREAM-ISSUES.md
 * (#1, #2).
 *
 * `Delivery` knows nothing about Pi: a `DeliveryHost` says whether Pi is idle and how to send,
 * which is also the seam for whoever provides a work host (the root session sends with
 * `sendMessage`; a managed child asks its manager for a run). A throw from the host (stale
 * context after reload or session replacement) is permanent: the delivery is disposed and
 * nothing is retried.
 */

export interface Completion<T> {
  /** Globally unique (UUID). Producers that deduplicate use it as the key. */
  completionId: string;
  payload: T;
}

/** "wake": Pi is idle, start a run (`triggerTurn: true`). "record": append only (`triggerTurn: false`). */
export type SendMode = "wake" | "record";

export interface DeliveryHost<T> {
  /** Pi's idle state. Throws if the context is stale. */
  isIdle(): boolean;
  /** One message for all `items`. Throws if the context is stale. */
  send(items: Completion<T>[], mode: SendMode): void;
  /** Called once when delivery stops for good (stale context) with what was not sent. */
  lost?(items: Completion<T>[]): void;
}

export class Delivery<T> {
  private host: DeliveryHost<T>;
  private suspended = false;
  private binding = 0;
  /** Completions waiting for a usable context: only while suspended for a reload. */
  private held: Completion<T>[] = [];
  private runActive = false;
  private disposed = false;
  /** Messages that were handed over but dropped when delivery stopped for good. */
  private readonly refused = new WeakSet<Completion<T>>();

  constructor(host: DeliveryHost<T>) {
    this.host = host;
  }

  get heldCount(): number {
    return this.held.length;
  }

  /** True once delivery has stopped for good (disposed, or the host refused a send). */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Hand a message over. Returns whether delivery accepted it: it was sent, or it is held for a
   * reload. False when delivery is disposed (before or because of this very send), in which case
   * the message goes nowhere and the caller must not treat it as delivered.
   */
  add(item: Completion<T>): boolean {
    if (this.disposed) return false;
    this.held.push(item);
    this.flush();
    return !this.refused.has(item);
  }

  onAgentStart(): void {
    if (!this.disposed && !this.suspended) this.runActive = true;
  }

  /** The run is over, including its continuations. Pi may be idle again. */
  onAgentSettled(): void {
    if (!this.disposed && !this.suspended) this.runActive = false;
  }

  /** Reload keeps completions, but must never call the stale extension API. */
  suspend(): void {
    this.binding++;
    this.suspended = true;
    this.runActive = false;
  }

  /** The replacement extension supplies a fresh context and API before anything is sent. */
  rebind(host: DeliveryHost<T>): void {
    this.host = host;
    const binding = ++this.binding;
    // Keep buffering until every extension's session_start handler has run.
    this.suspended = true;
    setImmediate(() => {
      if (this.binding !== binding || this.disposed) return;
      this.suspended = false;
      this.flush();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const lost = this.held;
    this.held = [];
    for (const item of lost) this.refused.add(item);
    if (lost.length) {
      try {
        this.host.lost?.(lost);
      } catch {}
    }
  }

  /**
   * Everything held goes out as ONE send: a wake when Pi is idle, otherwise a record that
   * Pi appends at the end of the turn.
   */
  private flush(): void {
    if (this.disposed || this.suspended || this.held.length === 0) return;
    const items = this.held.splice(0);
    let sent = false;
    try {
      const wake = !this.runActive && this.host.isIdle();
      this.host.send(items, wake ? "wake" : "record");
      sent = true;
      // A wake starts a run synchronously; what arrives next is a record for that run.
      if (wake) this.runActive = !this.host.isIdle();
    } catch {
      if (!sent) this.held.unshift(...items);
      this.dispose(); // Pi refused, or the context is stale: permanent
    }
  }
}

/** A message in a model context, as `agent_before_settle` reports it. */
export interface ContextMessage {
  role?: string;
  customType?: string;
  content?: unknown;
  details?: unknown;
}

/** The parts of an `agent_before_settle` event that `continuesRun` reads. */
export interface BeforeSettleEvent {
  outcome: string;
  context: {
    contextMessages: readonly ContextMessage[];
    pendingMessages: readonly ContextMessage[];
  };
}

/**
 * Whether the run needs one more model request because a delivered message arrived after the
 * model's last answer: the newest message in the context is one (`isDelivered`), or one is still
 * pending (Pi appends pending messages right after this handler). Only for a run that
 * completed: after an abort the message waits in the transcript for the next run, and after an
 * error continuing would just repeat the failing request.
 */
export function continuesRun(
  event: BeforeSettleEvent,
  isDelivered: (message: ContextMessage) => boolean,
): boolean {
  if (event.outcome !== "completed") return false;
  const delivered = (m: ContextMessage | undefined): boolean => !!m && isDelivered(m);
  return (
    delivered(event.context.contextMessages.at(-1)) ||
    event.context.pendingMessages.some((m) => delivered(m))
  );
}
