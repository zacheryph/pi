/**
 * context-card.ts — a context-only card an extension keeps at the end of the
 * model's messages.
 *
 * A card restores state the model may have lost (after a compaction, reload,
 * resume or `/tree`). It is appended on each `context` event as a `custom`
 * message with `display: false`, so it is never written to the transcript or
 * shown in the TUI, and the previous request's card is stripped first so only
 * the current one is ever sent.
 *
 * Whether a card is due is each extension's own rule; this module owns the
 * message surgery and optional restore-driven visibility.
 */

import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionCompactEvent,
  SessionStartEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";

export type AgentMessage = ContextEvent["messages"][number];

/** A `context` handler's result: new messages, or undefined when nothing changed. */
export type CardResult = { messages: AgentMessage[] } | undefined;

/** `messages` without any card of `type`. */
function stripCards(messages: readonly AgentMessage[], type: string): AgentMessage[] {
  return messages.filter((message) => !(message.role === "custom" && message.customType === type));
}

/**
 * The result for `card` given the event's `messages` and the same messages
 * with earlier cards `stripped`: the card appended when there is one, the
 * stripped messages when a card was removed, and undefined when neither.
 */
function placeCard(
  messages: readonly AgentMessage[],
  stripped: AgentMessage[],
  type: string,
  card: string | undefined,
  now: () => number = Date.now,
): CardResult {
  if (!card) return stripped.length === messages.length ? undefined : { messages: stripped };
  return {
    messages: [
      ...stripped,
      { role: "custom", customType: type, content: card, display: false, timestamp: now() },
    ],
  };
}

/** The session events after which the model may have lost what a card restores. */
export type RestoreEvent = SessionStartEvent | SessionTreeEvent | SessionCompactEvent;

export interface ContextCardOptions {
  /** The card's `customType`, e.g. `stash:context`. */
  type: string;
  /**
   * The card to send with this request, or undefined for none. `messages` are
   * the request's messages without earlier cards. May be async; a result that
   * resolves after shutdown, a newer restore event, or an explicit show/hide
   * call is dropped, even if the card has since been shown again.
   */
  build: (
    ctx: ExtensionContext,
    messages: AgentMessage[],
  ) => string | undefined | Promise<string | undefined>;
  /**
   * Makes the card restore-driven. After `session_start`, `session_tree` and
   * `session_compact` the card is shown when this returns true and hidden
   * otherwise; `session_shutdown` hides it, and so do `show`/`hide` calls. While
   * it is hidden `build` is not called. Without `restore`, `build` alone
   * decides on every request.
   *
   * Called after the extension's own handlers for the event that were
   * registered before `contextCard`, so it can read state they rebuilt. May be
   * async; a result superseded by another restore, shutdown or an explicit
   * show/hide call is dropped.
   */
  restore?: (ctx: ExtensionContext, event: RestoreEvent) => boolean | Promise<boolean>;
  /** Clock for the card's timestamp and `shownAt`. */
  now?: () => number;
}

/** A registered card's visibility, for an extension whose card is restore-driven. */
export interface ContextCard {
  /** Show the card from the next request on (it holds state the model has not seen). */
  show(): void;
  /** Stop sending the card (the model has now seen the state). */
  hide(): void;
  /** When the card was last shown; undefined while it is hidden. */
  shownAt(): number | undefined;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  !!value && typeof (value as { then?: unknown }).then === "function";

/**
 * Register the `context` handler that keeps one card of `options.type` at the
 * end of every request while it is due. Call it from the extension factory,
 * after the session handlers that rebuild the state `restore` reads; all state
 * stays in this call's closure.
 */
export function contextCard(
  pi: Pick<ExtensionAPI, "on">,
  options: ContextCardOptions,
): ContextCard {
  const { type, build, restore, now = Date.now } = options;
  /** Invalidates async work across restores and explicit visibility changes. */
  let revision = 0;
  let shownAt: number | undefined;
  const card: ContextCard = {
    show: () => {
      revision += 1;
      shownAt = now();
    },
    hide: () => {
      revision += 1;
      shownAt = undefined;
    },
    shownAt: () => shownAt,
  };
  const set = (due: boolean) => (due ? card.show() : card.hide());
  const restoreAfter = (event: RestoreEvent, ctx: ExtensionContext) => {
    const started = ++revision;
    if (!restore) return;
    const due = restore(ctx, event);
    if (!isThenable(due)) {
      if (started === revision) set(due);
      return;
    }
    return Promise.resolve(due).then((value) => {
      if (started === revision) set(value);
    });
  };

  pi.on("session_start", (event, ctx) => {
    return restoreAfter(event, ctx);
  });
  pi.on("session_tree", (event, ctx) => restoreAfter(event, ctx));
  pi.on("session_compact", (event, ctx) => restoreAfter(event, ctx));
  pi.on("session_shutdown", () => {
    card.hide();
  });
  pi.on("context", (event, ctx) => {
    const stripped = stripCards(event.messages, type);
    const due = () => !restore || shownAt !== undefined;
    const started = revision;
    const built = due() ? build(ctx, stripped) : undefined;
    const finish = (value: string | undefined) =>
      placeCard(
        event.messages,
        stripped,
        type,
        started === revision && due() ? value : undefined,
        now,
      );
    return isThenable(built) ? Promise.resolve(built).then(finish) : finish(built);
  });
  return card;
}
