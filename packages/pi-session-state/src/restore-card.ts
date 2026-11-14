/**
 * restore-card.ts — a card an extension writes into the transcript once a
 * compaction has summarized away the tool results that showed its state.
 *
 * The card is a `custom` message with `display: false`: hidden in the TUI, but
 * saved to the session and sent to the model like any other message. It is
 * written once, stays where it was written (so the conversation's prompt cache
 * keeps working), and is summarized with everything else by the next
 * compaction, which writes a fresh one.
 *
 * Only a compaction loses state. A resume, reload, fork or `/tree` keeps every
 * tool result on the branch in the model's context, so after those events a
 * card is written only when the branch's latest compaction has none after it
 * (a session compacted before the extension wrote cards).
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionCompactEvent,
  SessionStartEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";

/** The session events after which a card may be due. */
export type RestoreEvent = SessionStartEvent | SessionTreeEvent | SessionCompactEvent;

export interface RestoreCardOptions {
  /** The card's `customType`, e.g. `stash:context`. */
  type: string;
  /**
   * The card's text, or undefined when there is nothing to restore. Called only
   * when the branch's latest compaction has no card of `type` after it. May be
   * async; a result that resolves after shutdown or a newer restore event is
   * dropped.
   *
   * Called after the extension's own handlers for the event that were
   * registered before `restoreCard`, so it can read state they rebuilt.
   */
  build: (
    ctx: ExtensionContext,
    event: RestoreEvent,
  ) => string | undefined | Promise<string | undefined>;
}

type BranchEntry = { type: string; customType?: string };

/** Whether `ctx`'s branch has a compaction with no card of `type` after it. */
export function cardMissing(ctx: Pick<ExtensionContext, "sessionManager">, type: string): boolean {
  const branch = ctx.sessionManager.getBranch() as readonly BranchEntry[];
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (entry.type === "custom_message" && entry.customType === type) return false;
    if (entry.type === "compaction") return true;
  }
  return false;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  !!value && typeof (value as { then?: unknown }).then === "function";

/**
 * Register the handlers that write a card of `options.type` after a compaction.
 * Call it from the extension factory, after the session handlers that rebuild
 * the state `build` reads; all state stays in this call's closure.
 */
export function restoreCard(
  pi: Pick<ExtensionAPI, "on" | "sendMessage">,
  { type, build }: RestoreCardOptions,
): void {
  /** Invalidates async builds across restores and shutdown. */
  let revision = 0;
  /** Whether a card is still due; a stale context (after shutdown) answers no. */
  const due = (ctx: ExtensionContext) => {
    try {
      return cardMissing(ctx, type);
    } catch {
      return false;
    }
  };
  const restore = (event: RestoreEvent, ctx: ExtensionContext) => {
    const started = ++revision;
    if (!due(ctx)) return;
    const write = (card: string | undefined) => {
      if (!card || started !== revision || !due(ctx)) return;
      try {
        // Held until the turn ends when a run is streaming, so it never splits a
        // tool call from its result.
        pi.sendMessage({ customType: type, content: card, display: false }, { triggerTurn: false });
      } catch {
        // A closed session: the next restore writes it.
      }
    };
    const built = build(ctx, event);
    return isThenable(built) ? Promise.resolve(built).then(write) : write(built);
  };

  pi.on("session_start", (event, ctx) => restore(event, ctx));
  pi.on("session_tree", (event, ctx) => restore(event, ctx));
  pi.on("session_compact", (event, ctx) => restore(event, ctx));
  pi.on("session_shutdown", () => {
    revision += 1;
  });
}
