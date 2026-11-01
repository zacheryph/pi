import type { Focusable, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { bodyRow, labeledRule, titleText } from "./layout.ts";
import type { ModalContext, ModalFactory } from "./modal.ts";
import { paint } from "./style.ts";
import { sanitizeLine } from "./text.ts";
import type { DisposableComponent, Title, UITheme } from "./types.ts";

/**
 * What an inline window reads from the renderer. Pi's fullscreen TUI reports
 * whether the transcript still follows its end and can scroll back to it; the
 * regular TUI leaves scrollback to the terminal and reports neither.
 */
export type InlineWindowHost = Pick<TUI, "requestRender"> & {
  readonly isFollowingOutput?: boolean;
  scrollToBottom?(): void;
  scrollBy?(lines: number): void;
};

/** Rows of the minimized window: title rule, summary and hint. */
const MINIMIZED_ROWS = 3;

// Pi loads every extension with its own module cache, so each has its own copy
// of this library; the count of open windows lives on the shared global object.
const OPEN_WINDOWS = Symbol.for("pi-ui.inline-window.open");
type OpenWindows = { [OPEN_WINDOWS]?: number };
const openWindows = () => (globalThis as OpenWindows)[OPEN_WINDOWS] ?? 0;

/**
 * True while any extension has an inline window open. Docked widgets read it
 * (`WidgetView.docked`) to collapse to their heading so the window keeps its rows.
 */
export function inlineWindowOpen(): boolean {
  return openWindows() > 0;
}

/** Counts one open window; the returned release is idempotent. */
function trackOpenWindow(): () => void {
  (globalThis as OpenWindows)[OPEN_WINDOWS] = openWindows() + 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    (globalThis as OpenWindows)[OPEN_WINDOWS] = Math.max(0, openWindows() - 1);
  };
}

export interface InlineWindowOptions {
  title: Title;
  /** The minimized window's hint row; defaults to "any key returns". */
  minimizedHint?: string;
}

/** A body may say, in one line of plain text, what the minimized window is waiting on. */
export type InlineWindowBody = DisposableComponent &
  Partial<Focusable> & {
    summary?(): string;
  };

/**
 * A focused window in the editor's place, under the transcript, like a widget
 * that takes input. In fullscreen mode it shrinks to three rows (a dim title
 * rule, the body's one-line summary and a hint) while the transcript is
 * scrolled away from its end, so the session can be reviewed with the screen.
 * Three rows is what Pi reserves for the editor's place anyway. It keeps focus while minimized: the next key scrolls
 * back to the end and restores it. That key is not passed to the body, so a
 * keystroke typed without seeing the window never acts on it.
 *
 * Minimizing frees rows at the bottom of the transcript. Left alone, the
 * transcript would clamp to its new end, follow it again and restore the
 * window, which then minimizes on the next scroll: a flicker until the user
 * scrolls further than the freed rows at once. So the window scrolls the
 * transcript back by the rows it freed, keeping the last line the user saw at
 * the bottom of the view.
 *
 * In regular mode the terminal owns scrollback and the window never minimizes;
 * scrolling the terminal already moves it out of view.
 */
export class InlineWindow implements DisposableComponent, Focusable {
  private shownMinimized = false;
  /** Rows of the last expanded render; what minimizing frees, plus the minimized rows. */
  private expandedRows = 0;
  private readonly host: InlineWindowHost;
  private readonly theme: UITheme;
  private readonly body: InlineWindowBody;
  private readonly options: InlineWindowOptions;

  constructor(
    host: InlineWindowHost,
    theme: UITheme,
    body: InlineWindowBody,
    options: InlineWindowOptions,
  ) {
    this.host = host;
    this.theme = theme;
    this.body = body;
    this.options = options;
  }

  /** True while the transcript is scrolled away from its end. */
  get minimized(): boolean {
    return this.host.isFollowingOutput === false;
  }

  get focused(): boolean {
    return "focused" in this.body ? Boolean(this.body.focused) : false;
  }

  set focused(value: boolean) {
    if ("focused" in this.body) this.body.focused = value;
  }

  get wantsKeyRelease(): boolean | undefined {
    return this.body.wantsKeyRelease;
  }

  render(width: number): string[] {
    const minimized = this.minimized;
    if (minimized !== this.shownMinimized) {
      this.shownMinimized = minimized;
      const freed = this.expandedRows - MINIMIZED_ROWS;
      if (minimized && freed > 0) this.host.scrollBy?.(-freed);
      // The window's height changed, so the transcript above it needs another layout pass.
      this.host.requestRender();
    }
    const title = titleText(this.options.title);
    const rule = (text: string) => paint(this.theme, minimized ? "dim" : "accent", text);
    if (minimized) {
      const hint = sanitizeLine(this.options.minimizedHint ?? "any key returns");
      const summary = sanitizeLine(this.body.summary?.() ?? "");
      return [
        labeledRule(width, rule, [
          paint(this.theme, "accent", `▸ ${title}`),
          paint(this.theme, "accent", "▸"),
        ]),
        bodyRow(paint(this.theme, "muted", summary), width),
        bodyRow(paint(this.theme, "dim", hint), width),
      ];
    }
    const lines = [
      labeledRule(width, rule, [paint(this.theme, "accent", title)]),
      ...this.body.render(width),
    ];
    this.expandedRows = lines.length;
    return lines;
  }

  handleInput(data: string): void {
    if (this.minimized) {
      this.host.scrollToBottom?.();
      this.host.requestRender();
      return;
    }
    this.body.handleInput?.(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.minimized) return undefined;
    // The title rule is row 0; the body starts below it.
    return this.body.handleMouse?.({ ...event, y: event.y - 1, height: event.height - 1 });
  }

  invalidate(): void {
    this.body.invalidate();
  }

  dispose(): void {
    this.body.dispose?.();
  }
}

/**
 * Open a focused inline window in the editor's place and resolve with the value
 * the body passes to `done`, or undefined without an interactive terminal. The
 * signal ends on close, host disposal or failure. While it is open,
 * `inlineWindowOpen()` is true.
 */
export async function openInlineWindow<T>(
  ctx: ModalContext,
  title: Title,
  factory: ModalFactory<T>,
  options: { unavailableMessage?: string; minimizedHint?: string } = {},
): Promise<T | undefined> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify(
      options.unavailableMessage ?? "This view requires interactive terminal mode.",
      "warning",
    );
    return undefined;
  }
  const controller = new AbortController();
  let finished = false;
  let release: (() => void) | undefined;
  try {
    return await ctx.ui.custom<T>(async (tui, theme, keys, done) => {
      const body = await factory(
        tui,
        theme,
        keys,
        (value) => {
          if (!finished) {
            finished = true;
            controller.abort();
            done(value);
          }
        },
        controller.signal,
      );
      const window = new InlineWindow(tui as InlineWindowHost, theme, body, {
        title,
        ...(options.minimizedHint ? { minimizedHint: options.minimizedHint } : {}),
      });
      release = trackOpenWindow();
      let disposed = false;
      // Explicit delegation retains method receivers, focus and Pi Input cursor behavior.
      const host: DisposableComponent & Focusable = {
        get focused() {
          return window.focused;
        },
        set focused(value: boolean) {
          window.focused = value;
        },
        get wantsKeyRelease() {
          return window.wantsKeyRelease;
        },
        render: (width) => window.render(width),
        invalidate: () => window.invalidate(),
        handleInput: (data) => window.handleInput(data),
        handleMouse: (event) => window.handleMouse(event),
        dispose() {
          if (!disposed) {
            disposed = true;
            controller.abort();
            release?.();
            window.dispose();
          }
        },
      };
      return host;
    });
  } finally {
    controller.abort();
    release?.();
  }
}
