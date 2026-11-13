import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeText } from "#ui/text";

/**
 * "Show this text to the user" for slash commands.
 *
 * In Pi's terminal UI the text goes to `ctx.ui.notify`, as before. Everywhere
 * else it is a displayed custom message: an RPC host such as bb drops `notify`
 * but renders a message with `display: true` in its timeline.
 *
 * Delivery: the message is sent with `triggerTurn: false`, so it never starts a
 * model turn. While a run is active Pi holds it until the turn ends rather than
 * steering it between a tool call and its result. Pi puts every custom message
 * in the model's context, so a `context` handler (registered with the output)
 * drops these messages from each request: a command listing is for the user.
 * The message stays in the session file and in the host's timeline.
 */

export type OutputLevel = "info" | "warning" | "error";

/** The slice of a command context that decides where the text goes. */
export interface OutputContext {
  readonly mode: "tui" | "rpc" | "json" | "print";
  readonly hasUI: boolean;
  readonly ui: { notify(message: string, type?: OutputLevel): void };
}

/** The slice of the extension API the output uses. */
export type OutputApi = Pick<ExtensionAPI, "on" | "sendMessage">;

/** Marks a message as command output: shown to the user, never sent to the model. */
export const USER_OUTPUT_KEY = "userOutput";

/** Outside the terminal a message is bounded: a command listing is not a transcript. */
export const MAX_OUTPUT_LINES = 120;
export const MAX_OUTPUT_CHARS = 12_000;

const PREFIX: Record<OutputLevel, string> = { info: "", warning: "Warning: ", error: "Error: " };

/** True when the command can open Pi's terminal views (overlays, explorers, `ctx.ui.custom`). */
export function isTerminal(ctx: Pick<OutputContext, "mode" | "hasUI">): boolean {
  return ctx.mode === "tui" && ctx.hasUI;
}

/**
 * Cap `text` to `maxLines` lines and `maxChars` characters, ending with a line
 * that says how much was left out. Text within both limits is returned as is.
 */
export function capOutput(
  text: string,
  maxLines = MAX_OUTPUT_LINES,
  maxChars = MAX_OUTPUT_CHARS,
): string {
  const lines = text.split("\n");
  let kept = lines.slice(0, maxLines);
  let body = kept.join("\n");
  if (body.length > maxChars) {
    body = body.slice(0, maxChars);
    // Do not end on half a line unless the first line alone is over the limit.
    const cut = body.lastIndexOf("\n");
    if (cut > 0) body = body.slice(0, cut);
    kept = body.split("\n");
  }
  if (kept.length === lines.length && body.length === text.length) return text;
  const left = lines.length - kept.length;
  return `${body}\n… ${left > 0 ? `${left} more line${left === 1 ? "" : "s"}` : "output truncated"}`;
}

function isUserOutput(message: { role?: string; details?: unknown }): boolean {
  const details = message.details;
  return (
    message.role === "custom" &&
    typeof details === "object" &&
    details !== null &&
    (details as Record<string, unknown>)[USER_OUTPUT_KEY] === true
  );
}

export interface UserOutput {
  /**
   * Show `text` to the user. Terminal: `ctx.ui.notify(text, level)`, unchanged.
   * Elsewhere: a sanitized, bounded, displayed custom message that does not
   * start a turn and is not sent to the model; a warning or error says so in
   * its first words.
   */
  show(ctx: OutputContext, text: string, level?: OutputLevel): void;
}

const filtered = new WeakSet<object>();

/**
 * Output for one extension. `customType` names its messages. Call it from the
 * extension factory: it registers the `context` handler that keeps the messages
 * out of the model's context (once per `pi`, however many outputs share it).
 */
export function userOutput(pi: OutputApi, customType: string): UserOutput {
  if (!filtered.has(pi)) {
    filtered.add(pi);
    pi.on("context", (event) => {
      const messages = event.messages.filter((message) => !isUserOutput(message));
      return messages.length === event.messages.length ? undefined : { messages };
    });
  }
  return {
    show(ctx, text, level = "info") {
      if (ctx.mode === "tui") {
        ctx.ui.notify(text, level);
        return;
      }
      const content = capOutput(PREFIX[level] + sanitizeText(text));
      try {
        pi.sendMessage(
          { customType, content, display: true, details: { [USER_OUTPUT_KEY]: true, level } },
          { triggerTurn: false },
        );
      } catch {
        // A stale context or a closed session: the host's dialogs and notify are all that is left.
        if (ctx.hasUI) ctx.ui.notify(content, level);
      }
    },
  };
}
