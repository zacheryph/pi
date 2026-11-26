import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorText } from "#foundations/errors";
import { isTerminal, userOutput } from "#foundations/user-output";
import { dispatchAction, onViewChanged, type AttentionList, type AttentionRow } from "#surface";
import { openModal, paint, plainText, sanitizeLine } from "#ui";
import { AttentionView } from "#src/list";
import { openUrl } from "#src/open";
import { attentionViews, describe, EMPTY, hintText, readAttention } from "#src/rows";

/** The key of the status hint in Pi's footer. */
export const STATUS_KEY = "attention";

export interface AttentionDependencies {
  /** Open a URL in the user's browser; resolves false when it could not. Default: an argv launch through `pi.exec`. */
  openUrl?: (url: string) => Promise<boolean>;
  now?: () => number;
}

/**
 * What this session owes you: a status hint while anything is owed, and
 * `/attention` to open, print or dismiss it. Reads the `attention` views other
 * extensions publish on the session's own bus; publishes nothing itself.
 */
export default function piAttention(pi: ExtensionAPI, dependencies: AttentionDependencies = {}) {
  // Per-session state lives in this closure, never in module scope: every
  // subagent session runs this factory again, and a same-cwd child may share
  // this module with its parent.
  const output = userOutput(pi, "attention");
  const now = () => (dependencies.now ?? Date.now)();
  const open =
    dependencies.openUrl ?? ((url: string) => openUrl((...args) => pi.exec(...args), url));

  /** The context of the latest `session_start`, while the session runs with a UI. */
  let ui: ExtensionContext["ui"] | undefined;
  let stopWatching: (() => void) | undefined;
  /** The attention views seen on the last read, so their removal is noticed. */
  let known: ReadonlySet<string> = new Set();
  let hint: string | undefined;
  let pending = false;
  /** The `/attention` overlay while it is open. */
  let view: AttentionView | undefined;

  const read = (): { list: AttentionList; views: ReadonlySet<string> } => {
    try {
      return readAttention(pi.events);
    } catch {
      // A bus Pi has retired throws; nothing on it is owed any more.
      return { list: EMPTY, views: new Set() };
    }
  };

  const isAttentionView = (id: string): boolean => {
    try {
      return attentionViews(pi.events).has(id);
    } catch {
      return false;
    }
  };

  const setHint = (text: string | undefined): void => {
    if (text === hint || !ui) return;
    hint = text;
    try {
      ui.setStatus(STATUS_KEY, text && paint(ui.theme, "warning", text));
    } catch {
      // A context from before a reload throws; the next session_start sets the hint again.
    }
  };

  const refresh = (): void => {
    pending = false;
    if (!ui) return;
    const { list, views } = read();
    known = views;
    setHint(hintText(list));
    view?.setList(list);
  };

  /** Read once per burst of announcements, after the producer has finished announcing. */
  const schedule = (): void => {
    if (pending) return;
    pending = true;
    queueMicrotask(refresh);
  };

  const stop = (): void => {
    stopWatching?.();
    stopWatching = undefined;
    setHint(undefined);
    ui = undefined;
    view = undefined;
    known = new Set();
  };

  pi.on("session_start", (_event, ctx) => {
    stop();
    // Subagents have no one to show a hint to; `/attention` still reads on demand.
    if (!ctx.hasUI) return;
    ui = ctx.ui;
    stopWatching = onViewChanged(pi.events, (id) => {
      // Widgets announce often; only an attention view's change (or removal) is read.
      if (known.has(id) || isAttentionView(id)) schedule();
    });
    refresh();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ui = ctx.ui;
    stop();
  });

  const openRow = async (ctx: ExtensionContext, row: AttentionRow): Promise<void> => {
    if (row.link) {
      if (await open(row.link.url)) return;
      // No browser here (SSH, no display) or it failed: the URL is what the user needs.
      output.show(ctx, `${sanitizeLine(row.link.label)}: ${sanitizeLine(row.link.url)}`, "info");
    } else if (row.open) {
      try {
        await dispatchAction(pi.events, row.open.action, row.open.args);
      } catch (error) {
        output.show(ctx, `Couldn't open ${plainText(row.title)}: ${errorText(error)}`, "error");
      }
    }
  };

  const dismissRow = async (ctx: ExtensionContext, row: AttentionRow): Promise<void> => {
    if (!row.dismiss) return;
    try {
      await dispatchAction(pi.events, row.dismiss.action, row.dismiss.args);
    } catch (error) {
      output.show(ctx, `Couldn't dismiss ${plainText(row.title)}: ${errorText(error)}`, "error");
    }
  };

  pi.registerCommand("attention", {
    description: "What this session owes you: open a link, or dismiss an item",
    handler: async (_args, ctx) => {
      const current = read().list;
      if (!isTerminal(ctx)) {
        output.show(ctx, describe(current, now()), "info");
        return;
      }
      if (!current.rows.length) {
        output.show(ctx, describe(current, now()), current.failed.length ? "warning" : "info");
        return;
      }
      let chosen: AttentionRow | undefined;
      await openModal<void>(
        ctx,
        (tui, theme, keys, done) => {
          view = new AttentionView({
            tui,
            theme,
            keys,
            list: current,
            now,
            onOpen: (row) => (chosen = row),
            onDismiss: (row) => void dismissRow(ctx, row),
            done: () => done(undefined),
          });
          return view;
        },
        { command: "/attention" },
      );
      view = undefined;
      if (chosen) await openRow(ctx, chosen);
    },
  });
}
