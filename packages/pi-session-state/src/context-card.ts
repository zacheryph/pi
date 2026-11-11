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
 * Whether a card is due is each extension's own rule, decided inside `build`;
 * this module owns only the message surgery.
 */

import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type AgentMessage = ContextEvent["messages"][number];

/** A `context` handler's result: new messages, or undefined when nothing changed. */
export type CardResult = { messages: AgentMessage[] } | undefined;

/** `messages` without any card of `type`. */
export function stripCards(messages: readonly AgentMessage[], type: string): AgentMessage[] {
  return messages.filter((message) => !(message.role === "custom" && message.customType === type));
}

/**
 * The result for `card` given the event's `messages` and the same messages
 * with earlier cards `stripped`: the card appended when there is one, the
 * stripped messages when a card was removed, and undefined when neither.
 */
export function placeCard(
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

/**
 * Strip earlier cards of `type`, then append the one `build` returns (undefined
 * for no card now). `build` sees the messages without earlier cards. Returns
 * undefined when the messages need no change.
 */
export function applyCard(
  messages: readonly AgentMessage[],
  type: string,
  build: (messages: AgentMessage[]) => string | undefined,
  now: () => number = Date.now,
): CardResult {
  const stripped = stripCards(messages, type);
  return placeCard(messages, stripped, type, build(stripped), now);
}

export interface ContextCardOptions {
  /** The card's `customType`, e.g. `stash:context`. */
  type: string;
  /**
   * The card to send with this request, or undefined for none. `messages` are
   * the request's messages without earlier cards. May be async; a result that
   * resolves after `session_shutdown` or a newer `session_start` is dropped.
   */
  build: (
    ctx: ExtensionContext,
    messages: AgentMessage[],
  ) => string | undefined | Promise<string | undefined>;
  /** Clock for the card's timestamp. */
  now?: () => number;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  !!value && typeof (value as { then?: unknown }).then === "function";

/**
 * Register the `context` handler that keeps one card of `options.type` at the
 * end of every request while `build` returns one. Call it from the extension
 * factory; all state stays in this call's closure.
 */
export function contextCard(pi: Pick<ExtensionAPI, "on">, options: ContextCardOptions): void {
  const { type, build, now = Date.now } = options;
  /** Bumped on every session start and shutdown, so a stale async build drops its card. */
  let generation = 0;
  const bump = () => {
    generation += 1;
  };
  pi.on("session_start", bump);
  pi.on("session_shutdown", bump);
  pi.on("context", (event, ctx) => {
    const stripped = stripCards(event.messages, type);
    const built = build(ctx, stripped);
    if (!isThenable(built)) return placeCard(event.messages, stripped, type, built, now);
    const started = generation;
    return Promise.resolve(built).then((card) =>
      placeCard(event.messages, stripped, type, started === generation ? card : undefined, now),
    );
  });
}
