/**
 * context-card.ts — a context-only card an extension keeps at the end of the
 * model's messages.
 *
 * The card is appended on each `context` event as a `custom` message with
 * `display: false`, so it is never written to the transcript or shown in the
 * TUI, and the previous request's card is stripped first so only the current
 * one is ever sent.
 *
 * A card at the end of every request moves with the conversation: the model
 * reads it as the newest message, and on providers with explicit cache
 * breakpoints it keeps the conversation from being cached while it is sent. Use
 * it only for state that changes under the model and must be current on every
 * request (pi-todo's list, which commands and subagents edit), and let `build`
 * return undefined as soon as a visible tool result holds the state. To bring
 * back state a compaction summarized away, use `restoreCard` instead.
 */

import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
  now: () => number,
): CardResult {
  if (!card) return stripped.length === messages.length ? undefined : { messages: stripped };
  return {
    messages: [
      ...stripped,
      { role: "custom", customType: type, content: card, display: false, timestamp: now() },
    ],
  };
}

export interface ContextCardOptions {
  /** The card's `customType`, e.g. `todo:context`. */
  type: string;
  /**
   * The card to send with this request, or undefined for none. `messages` are
   * the request's messages without earlier cards. May be async.
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
  pi.on("context", (event, ctx) => {
    const stripped = stripCards(event.messages, type);
    const built = build(ctx, stripped);
    const finish = (value: string | undefined) =>
      placeCard(event.messages, stripped, type, value, now);
    return isThenable(built) ? Promise.resolve(built).then(finish) : finish(built);
  });
}
