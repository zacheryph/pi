/**
 * Completion delivery through Pi's own run boundaries (no timers, no polling, no queue of ours).
 *
 * A completion is a custom message in the session transcript, so the transcript is the inbox and
 * nothing a user does can lose it. Two paths, both `pi.sendMessage`:
 *  - Idle: `triggerTurn: true`. Pi starts a run with the completion as its trigger.
 *  - A run is active (agent_start ... agent_settled), or Pi is busy without one (compaction,
 *    branch summary): `triggerTurn: false`. Pi appends the message at the end of the current turn
 *    (immediately when it is not streaming), never between a tool call and its result, so the
 *    model sees it in the same run when another turn follows. When none does, the
 *    `agent_before_settle` handler (`continuesRun`) asks Pi for one more request. After Escape or
 *    abort the message stays in the transcript and no turn is forced; the next run sees it.
 *
 * What this does not do: wake an idle session that was busy without a run (a manual `/compact`
 * or `/tree`) when the completion arrived. The message is in the transcript, and the next run
 * answers it. Pi-side races on the idle path are documented in UPSTREAM-ISSUES.md (#1, #2).
 *
 * The model sees each completion id at most once per context: `dedupeCompletions` strips
 * already-shown completion blocks, keyed on unique ids. It exists for transcripts written by
 * older versions, which could deliver a completion twice. A throw from Pi (stale context after
 * reload or session replacement) is permanent: the delivery is disposed and nothing is retried.
 */

/** Custom message type of completion messages. */
export const CUSTOM_TYPE = "job:completion";

export interface Completion<T> {
  /** Globally unique (UUID); the only key used for deduplication. */
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

  constructor(host: DeliveryHost<T>) {
    this.host = host;
  }

  get heldCount(): number {
    return this.held.length;
  }

  add(item: Completion<T>): void {
    if (this.disposed) return;
    this.held.push(item);
    this.flush();
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
    if (lost.length) {
      try {
        this.host.lost?.(lost);
      } catch {}
    }
  }

  /**
   * Everything held goes out as ONE message: a wake when Pi is idle, otherwise a record that
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

/** The parts of an `agent_before_settle` event that `continuesRun` reads. */
export interface BeforeSettleEvent {
  outcome: string;
  context: {
    contextMessages: readonly ContextMessage[];
    pendingMessages: readonly ContextMessage[];
  };
}

const isCompletion = (m: ContextMessage | undefined): boolean =>
  m?.role === "custom" && m.customType === CUSTOM_TYPE;

/**
 * Whether the run needs one more model request because a completion arrived after the model's
 * last answer: the newest message in the context is a completion, or one is still pending (Pi
 * appends pending messages right after this handler). Only for a run that completed: after an
 * abort the completion waits in the transcript for the next run, and after an error continuing
 * would just repeat the failing request.
 */
export function continuesRun(event: BeforeSettleEvent): boolean {
  if (event.outcome !== "completed") return false;
  return (
    isCompletion(event.context.contextMessages.at(-1)) ||
    event.context.pendingMessages.some(isCompletion)
  );
}

interface ContextMessage {
  role?: string;
  customType?: string;
  content?: unknown;
  details?: unknown;
}

interface CompletionRef {
  completionId: string;
  /** Content part of this completion's block; absent in older single-part messages. */
  part?: number;
}

/** Completions carried by a pi-job message (none for other messages or the round-2 format). */
export function completionRefs(message: ContextMessage): CompletionRef[] {
  if (message?.role !== "custom" || message.customType !== CUSTOM_TYPE) return [];
  const list = (
    message.details as { completions?: { completionId?: unknown; part?: unknown }[] } | undefined
  )?.completions;
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => typeof c?.completionId === "string" && c.completionId.length > 0)
    .map((c) => ({
      completionId: c.completionId as string,
      ...(Number.isInteger(c.part) ? { part: c.part as number } : {}),
    }));
}

export const DUPLICATE_STUB = "[pi-job: this completion was already delivered above; nothing new.]";

function stripped(count: number): string {
  return `[pi-job: ${count} completion${count === 1 ? "" : "s"} already shown above omitted.]\n\n`;
}

/**
 * Model-context filter, keyed on unique completion ids only (display handles such as `j1` are
 * never compared). In each pi-job message, the block of every completion already shown earlier
 * in the context is removed and replaced by a one-line note; unseen blocks are kept as they
 * are. A message left with no unseen completion becomes a one-line stub (kept, not removed, so
 * the context never ends on an assistant message). Messages without per-block part indices can
 * only be stubbed as a whole, when all their ids were seen. Returns undefined if nothing changed.
 */
export function dedupeCompletions<M extends ContextMessage>(messages: M[]): M[] | undefined {
  const seen = new Set<string>();
  let changed = false;
  const out = messages.map((m) => {
    const refs = completionRefs(m);
    if (refs.length === 0) return m;
    const repeats = refs.filter((r) => seen.has(r.completionId));
    for (const r of refs) seen.add(r.completionId);
    if (repeats.length === 0) return m;
    if (repeats.length === refs.length) {
      changed = true;
      return { ...m, content: [{ type: "text", text: DUPLICATE_STUB }] };
    }
    const parts = Array.isArray(m.content) ? m.content : undefined;
    const drop = new Set(repeats.map((r) => r.part));
    if (!parts || drop.has(undefined) || [...drop].some((i) => i! >= parts.length)) return m; // cannot split: keep whole
    changed = true;
    // Drop the repeated blocks and the batch header (its count is stale); say what was omitted.
    const blockParts = new Set(refs.map((r) => r.part));
    const kept = parts
      .map((part, i) => ({ part, i }))
      .filter(({ i }) => !drop.has(i) && (blockParts.has(i) || i > 0));
    // Keep details consistent with the new content (idempotent re-filtering): drop the omitted
    // completions and point the remaining ones at their new part index (after the note).
    const newIndex = new Map(kept.map(({ i }, k) => [i, k + 1]));
    const omitted = new Set(repeats.map((r) => r.completionId));
    const details = m.details as { completions: { completionId?: unknown; part?: unknown }[] };
    const completions = details.completions
      .filter((c) => !omitted.has(c?.completionId as string))
      .map((c) =>
        newIndex.has(c?.part as number) ? { ...c, part: newIndex.get(c.part as number) } : c,
      );
    return {
      ...m,
      content: [{ type: "text", text: stripped(repeats.length) }, ...kept.map((k) => k.part)],
      details: { ...details, completions },
    };
  });
  return changed ? out : undefined;
}
