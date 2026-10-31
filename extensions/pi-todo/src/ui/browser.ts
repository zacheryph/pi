import { formatTodoAge, todoTaskDetail, orderedTodoTasks, todoTaskPresentation } from "./render.js";
import {
  createTodoReviewState, lastTodoActivityAt, type TodoActivity, type TodoReviewState, unreviewedTodoTasks,
} from "../activity.js";
import type { TodoState } from "../state.js";
import { sanitizeTodoText } from "./text.js";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  type Keybinding,
  type KeybindingsManager,
  matchesKey,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
/**
 * Adapted from repository-local pi-subagents/src/ui/read-only-browser.ts,
 * itself adapted from pi-system-insights/src/viewer.ts. Own copy for standalone
 * installs; no sibling runtime imports. Local changes: todo snapshot, semantic
 * status colors, command footer, task detail, shared sanitization, view tabs,
 * unreviewed markers and review callbacks.
 *
 * MIT License
 *
 * Copyright (c) 2026 tintinweb
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
export interface BrowserItem {
  id: string;
  label: string;
  status?: string;
  badge?: { label: string; color: "success" | "dim" | "accent" | "warning" };
  /** Unreviewed marker; any marked item reserves a marker column for every row. */
  marker?: boolean;
  /** Search metadata, not displayed in list rows. */
  description: string;
  detail: string;
}

export interface BrowserTab {
  label: string;
  /** Ordered subset of item ids. */
  ids: readonly string[];
  /** Shown when the view itself has no items. */
  empty?: string;
}

export interface BrowserView {
  title: string;
  note: string;
  items: readonly BrowserItem[];
  /** Tab/Shift+Tab cycle these; absent means one view of every item. */
  views?: readonly BrowserTab[];
  initialView?: number;
  /** Enter opened an item's details; its marker clears locally. */
  onOpen?: (id: string) => void;
  /** Ctrl+R: marked items in the current filtered list; markers clear locally. */
  onReview?: (ids: string[]) => void;
}

const MARKER = "●";

const NOTHING: Component = { render: () => [], invalidate() {} };

type ViewerContext = Pick<ExtensionContext, "mode" | "hasUI" | "ui">;

/** Probe the renderer, not the fullscreen setting (which may be overridden). */
export async function showReadOnlyBrowser(ctx: ViewerContext, view: BrowserView): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("Read-only browser requires TUI mode.", "warning");
    return;
  }
  // Capture before awaiting: this interaction is a read-only snapshot.
  const snapshot: BrowserView = {
    ...view,
    items: view.items.map((item) => ({ ...item, badge: item.badge && { ...item.badge } })),
    views: view.views?.map((tab) => ({ ...tab, ids: [...tab.ids] })),
  };
  const mode = await ctx.ui.custom<TUI["mode"] | undefined>((tui, _theme, _keys, done) => {
    done(tui.mode);
    return NOTHING;
  });
  await ctx.ui.custom<void>(
    (tui, theme, keys, done) => new ReadOnlyBrowser({ tui, theme, keys, view: snapshot, done }),
    mode === "fullscreen"
      ? { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } }
      : { overlay: false },
  );
}

export interface ReadOnlyBrowserOptions {
  tui: Pick<TUI, "mode" | "requestRender"> & { terminal: Pick<TUI["terminal"], "rows" | "columns"> };
  theme: Pick<Theme, "fg" | "bold">;
  keys: Pick<KeybindingsManager, "matches" | "getKeys">;
  view: BrowserView;
  done: (result: undefined) => void;
}

/** Bounded plain-text/list viewer. Owns no terminal, files, settings, or live data. */
export class ReadOnlyBrowser implements Component, Focusable {
  focused = false;
  private readonly input: Input;
  private readonly view: Pick<BrowserView, "title" | "note">;
  private readonly items: BrowserItem[];
  private readonly tabs: BrowserTab[] | undefined;
  private readonly markers: boolean;
  private tab: number;
  private filtered: BrowserItem[];
  private selected = 0;
  private detail: BrowserItem | undefined;
  private offset = 0;
  private closed = false;
  private width: number;
  private layout: { width: number; text: string; lines: string[] } | undefined;

  constructor(private readonly options: ReadOnlyBrowserOptions) {
    const cleanLine = (text: string) => sanitizeTodoText(text).replace(/\n/g, " ");
    this.view = {
      title: cleanLine(options.view.title),
      note: cleanLine(options.view.note),
    };
    this.items = options.view.items.map((item) => ({
      id: cleanLine(item.id),
      label: cleanLine(item.label),
      status: item.status === undefined ? undefined : cleanLine(item.status),
      badge: item.badge && { label: cleanLine(item.badge.label), color: item.badge.color },
      marker: item.marker,
      description: cleanLine(item.description),
      detail: sanitizeTodoText(item.detail),
    }));
    this.markers = this.items.some((item) => item.marker);
    this.tabs = options.view.views?.length ? options.view.views.map((tab) => ({
      label: cleanLine(tab.label), ids: tab.ids.map(cleanLine), ...(tab.empty ? { empty: cleanLine(tab.empty) } : {}),
    })) : undefined;
    this.tab = Math.max(0, Math.min((this.tabs?.length ?? 1) - 1, Math.floor(options.view.initialView ?? 0) || 0));
    this.filtered = this.tabItems();
    this.width = options.tui.terminal.columns;
    this.input = new Input({
      prompt: "Filter: ",
      placeholder: "type to search",
      placeholderStyle: (text) => options.theme.fg("dim", text),
    });
  }

  private get isList(): boolean {
    return !this.detail;
  }

  private title(): string {
    const root = this.view.title;
    return this.detail ? `${root} / ${this.detail.label}` : root;
  }

  private coreHints(contentWidth: number): string[] {
    let hint: string;
    if (this.isList) {
      hint = contentWidth >= 40 ? "Enter to see · Esc to close/clear filter"
        : contentWidth >= 27 ? "Enter see · Esc clear/close"
        : contentWidth >= 11 ? "Enter · Esc"
        : contentWidth >= 9 ? "Enter/Esc"
        : contentWidth >= 5 ? "↵/Esc"
        : contentWidth >= 3 ? "↵/⎋"
        : "Esc · Enter";
    } else {
      hint = contentWidth >= 14 ? "Esc to go back"
        : contentWidth >= 9 ? "Esc back" : "Esc";
    }
    // Shorten before wrapping: both actions outrank lengthy paging labels.
    return wrapTextWithAnsi(hint, Math.max(1, contentWidth));
  }

  private geometry() {
    const height = Math.max(0, Math.floor(this.options.tui.terminal.rows * 0.8));
    const frame = this.width >= 3 && height >= 3;
    const outerX = frame && this.width >= 7 ? 1 : 0;
    const innerX = frame && this.width >= 5 ? 1 : 0;
    const borderWidth = Math.max(0, this.width - 2 * outerX);
    const contentWidth = Math.max(1, borderWidth - (frame ? 2 + 2 * innerX : 0));
    // Reserve one content row before allocating chrome. Relax padding first at
    // small sizes; never depend on an overlay maxHeight cropping our output.
    let remaining = Math.max(0, height - (frame ? 2 : 0) - 1);
    const take = (cost: number, spare = 0): boolean => {
      if (cost <= 0 || remaining < cost + spare) return false;
      remaining -= cost;
      return true;
    };
    const core = this.coreHints(contentWidth);
    const footerRows = remaining ? Math.min(core.length, Math.max(1, remaining - Number(frame))) : 0;
    remaining -= footerRows;
    const divider = !!footerRows && frame && take(1);
    const filter = this.isList && take(1);
    const position = take(1, 1);
    const innerY = frame && take(2, 2) ? 1 : 0;
    const outerY = frame && take(2, 2) ? 1 : 0;
    const note = !!this.view.note && take(1, 2);
    const actions = this.isList ? [
      ...((this.tabs?.length ?? 0) > 1 ? ["Tab view"] : []),
      ...(this.markers && this.options.view.onReview ? ["Ctrl+R mark reviewed"] : []),
    ] : [];
    const navigation = wrapTextWithAnsi(
      `↑↓ ${this.isList ? "select" : "scroll"} · ${[...actions, this.pageHints()].join(" · ")} · Ctrl+C close`, contentWidth,
    );
    const commands = wrapTextWithAnsi("Edit: /todos:add · /todos:clear", contentWidth);
    const commandRows = take(commands.length, 2) ? commands.length : 0;
    const navigationRows = take(navigation.length, 2) ? navigation.length : 0;
    const body = height ? remaining + 1 : 0;
    return {
      height, frame, outerX, innerX, borderWidth, contentWidth, innerY, outerY,
      filter, footerRows, divider, position, note, navigationRows, commandRows, body, core, navigation, commands,
    };
  }

  private textLines(): string[] {
    const text = this.detail?.detail ?? "";
    const width = this.geometry().contentWidth;
    if (!this.layout || this.layout.width !== width || this.layout.text !== text) {
      this.layout = { width, text, lines: wrapTextWithAnsi(text, width) };
    }
    return this.layout.lines;
  }

  private move(delta: number): void {
    const body = Math.max(1, this.geometry().body);
    if (this.isList) {
      this.selected = Math.max(0, Math.min(this.filtered.length - 1, this.selected + delta));
    } else {
      this.offset = Math.max(0, Math.min(Math.max(0, this.textLines().length - body), this.offset + delta));
    }
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const { keys } = this.options;
    if (matchesKey(data, "ctrl+c")) {
      this.close();
      return;
    }
    if (matchesKey(data, "escape")) {
      if (this.detail) {
        this.detail = undefined;
        this.offset = 0;
      } else if (this.isList && this.input.getValue()) {
        this.input.setValue("");
        this.filter();
      } else {
        this.close();
        return;
      }
    } else if (matchesKey(data, "up") || keys.matches(data, "tui.altScreen.lineUp")) {
      this.move(-1);
    } else if (matchesKey(data, "down") || keys.matches(data, "tui.altScreen.lineDown")) {
      this.move(1);
    } else if (keys.matches(data, "tui.altScreen.pageUp")) {
      this.move(-Math.max(1, this.geometry().body));
    } else if (keys.matches(data, "tui.altScreen.pageDown")) {
      this.move(Math.max(1, this.geometry().body));
    } else if (matchesKey(data, "home") || keys.matches(data, "tui.altScreen.top")) {
      this.move(-Infinity);
    } else if (matchesKey(data, "end") || keys.matches(data, "tui.altScreen.bottom")) {
      this.move(Infinity);
    } else if (this.isList && this.tabs && this.tabs.length > 1 && (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))) {
      const step = matchesKey(data, "tab") ? 1 : -1;
      this.tab = (this.tab + step + this.tabs.length) % this.tabs.length;
      this.filter();
    } else if (this.isList && matchesKey(data, "ctrl+r")) {
      const marked = this.filtered.filter((item) => item.marker);
      if (marked.length && this.options.view.onReview) {
        this.options.view.onReview(marked.map((item) => item.id));
        for (const item of marked) item.marker = false;
      }
    } else if (this.isList && matchesKey(data, "enter")) {
      this.detail = this.filtered[this.selected];
      this.offset = 0;
      if (this.detail) {
        this.options.view.onOpen?.(this.detail.id);
        if (this.detail.marker) this.detail.marker = false;
      }
    } else if (this.isList) {
      const before = this.input.getValue();
      this.input.handleInput(data);
      // Built-in Input accepts bracketed paste; scrub its untrusted contents too.
      const safe = sanitizeTodoText(this.input.getValue()).replace(/\n/g, " ");
      if (safe !== this.input.getValue()) this.input.setValue(safe);
      if (before !== safe) this.filter();
    }
    this.invalidate();
    this.options.tui.requestRender();
  }

  private tabItems(): BrowserItem[] {
    const tab = this.tabs?.[this.tab];
    if (!tab) return this.items;
    const byId = new Map(this.items.map((item) => [item.id, item]));
    return tab.ids.flatMap((id) => byId.get(id) ?? []);
  }

  private filter(): void {
    const query = this.input.getValue().toLocaleLowerCase();
    this.filtered = this.tabItems().filter((item) =>
      `${item.label} ${item.status ?? ""} ${item.description}`.toLocaleLowerCase().includes(query),
    );
    this.selected = 0;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed || this.options.tui.mode !== "fullscreen" || event.type !== "wheel") return undefined;
    this.move(event.wheelDelta ?? 0);
    this.invalidate();
    this.options.tui.requestRender();
    return { handled: true };
  }

  /** Clip only the left side; badge/status always owns its own columns/color. */
  private itemRow(left: string, item: BrowserItem, width: number, selected = false): string {
    const { theme } = this.options;
    const right = item.badge?.label ?? item.status ?? "";
    const rightWidth = visibleWidth(right);
    const leftStyle = (text: string) => selected ? theme.fg("accent", text) : text;
    if (!right || rightWidth + 2 >= width) return leftStyle(truncateToWidth(left, width, ""));
    const clipped = truncateToWidth(left, width - rightWidth - 1, "");
    return leftStyle(clipped) + " ".repeat(width - visibleWidth(clipped) - rightWidth)
      + theme.fg(item.badge?.color ?? "dim", right);
  }

  render(width: number): string[] {
    this.width = Math.max(0, Math.floor(width));
    const g = this.geometry();
    this.input.focused = this.focused && this.isList && g.filter;
    if (this.width === 0 || g.height === 0) return [];
    const { theme } = this.options;
    const lines: string[] = [];
    const blank = " ".repeat(this.width);
    const margin = " ".repeat(g.outerX);
    const border = (text: string) => margin + theme.fg("border", text) + margin;
    const row = (text = "") => {
      // Input's zero-width cursor marker must survive this padded composition.
      const fitted = truncateToWidth(text, g.contentWidth, "", true);
      return g.frame
        ? margin + theme.fg("border", "│") + " ".repeat(g.innerX) + fitted
          + " ".repeat(g.innerX) + theme.fg("border", "│") + margin
        : truncateToWidth(text, this.width, "", true);
    };
    if (g.outerY) lines.push(blank);
    if (g.frame) {
      const innerWidth = g.borderWidth - 2;
      const title = truncateToWidth(` ${this.title()} `, innerWidth, "");
      const spare = Math.max(0, innerWidth - visibleWidth(title));
      const left = Math.floor(spare / 2);
      lines.push(margin + theme.fg("border", `╭${"─".repeat(left)}`)
        + theme.fg("accent", theme.bold(title))
        + theme.fg("border", `${"─".repeat(spare - left)}╮`) + margin);
    }
    if (g.innerY) lines.push(row());
    if (g.note) {
      const unreviewed = this.items.filter((item) => item.marker).length;
      const note = this.markers ? `${this.view.note} · ${unreviewed ? `${unreviewed} unreviewed` : "all reviewed"}` : this.view.note;
      lines.push(row(theme.fg("muted", note)));
    }
    if (g.filter) lines.push(row(this.input.render(g.contentWidth)[0] ?? ""));
    let position: string;
    const tab = this.tabs?.[this.tab];
    if (this.isList) {
      this.selected = Math.max(0, Math.min(this.selected, this.filtered.length - 1));
      const start = Math.max(0, Math.min(
        this.selected - Math.floor(g.body / 2), this.filtered.length - g.body,
      ));
      const empty = tab?.empty && !this.tabItems().length ? tab.empty : "No matching tasks.";
      for (let i = 0; i < g.body; i++) {
        const index = start + i;
        const item = this.filtered[index];
        const prefix = index === this.selected ? "→ " : "  ";
        // Selected rows are accent as a whole; others color only the marker.
        const mark = !this.markers || !item ? "" : !item.marker ? "  "
          : index === this.selected ? `${MARKER} ` : `${theme.fg("accent", MARKER)} `;
        const text = item
          ? this.itemRow(`${prefix}${mark}${item.label}`, item, g.contentWidth, index === this.selected)
          : (!i && !this.filtered.length ? theme.fg("muted", empty) : "");
        lines.push(row(text));
      }
      position = `${tab ? `${tab.label} · ` : ""}`
        + `${this.filtered.length ? this.selected + 1 : 0}/${this.filtered.length} tasks · ${this.items.length} total`;
    } else {
      const content = this.textLines();
      this.offset = Math.min(this.offset, Math.max(0, content.length - g.body));
      for (let i = 0; i < g.body; i++) {
        const index = this.offset + i;
        const text = content[index] ?? "";
        // Only first original Name row, never a continuation or scrolled row.
        lines.push(row(index === 0 && this.detail?.badge
          ? this.itemRow(text, this.detail, g.contentWidth) : text));
      }
      position = `${content.length ? this.offset + 1 : 0}–${Math.min(content.length, this.offset + g.body)}/${content.length} lines`;
    }
    if (g.divider) lines.push(border(`├${"─".repeat(g.borderWidth - 2)}┤`));
    for (const hint of g.core.slice(0, g.footerRows)) lines.push(row(theme.fg("dim", hint)));
    if (g.position) lines.push(row(theme.fg("dim", position)));
    for (const hint of g.navigation.slice(0, g.navigationRows)) lines.push(row(theme.fg("dim", hint)));
    for (const hint of g.commands.slice(0, g.commandRows)) lines.push(row(theme.fg("dim", hint)));
    if (g.innerY) lines.push(row());
    if (g.frame) lines.push(border(`╰${"─".repeat(g.borderWidth - 2)}╯`));
    if (g.outerY) lines.push(blank);
    return lines.slice(0, g.height);
  }

  private pageHints(): string {
    const pair = (first: Keybinding, second: Keybinding) => [first, second]
      .flatMap((binding) => this.options.keys.getKeys(binding).slice(0, 1))
      .map((key) => key.split("+").map((part) => part[0].toUpperCase() + part.slice(1)).join("+"))
      .join("/");
    return [pair("tui.altScreen.pageUp", "tui.altScreen.pageDown"), "Home/End",
      pair("tui.altScreen.top", "tui.altScreen.bottom")].filter(Boolean).join(" · ");
  }

  invalidate(): void {
    // Wrapped content is plain text: keyed by content + actual content width,
    // independent of theme and scroll/selection changes.
    this.input.invalidate();
  }

  private close(): void {
    this.closed = true;
    this.options.done(undefined);
  }

  dispose(): void {
    this.closed = true;
  }
}

export type TodoBrowserView = "all" | "unreviewed" | "recent";
const TODO_VIEWS: readonly TodoBrowserView[] = ["all", "unreviewed", "recent"];

export interface TodoBrowserOptions {
  /** Enables history details, unreviewed markers and view tabs. */
  activity?: TodoActivity;
  review?: TodoReviewState;
  now?: number;
  view?: TodoBrowserView;
  /** Review watermarks (key → revision) for messages this snapshot showed. */
  onReview?: (marks: ReadonlyMap<string, number>) => void;
  /** Subagent holding each delegated task, as a display label. */
  assignees?: ReadonlyMap<string, string>;
}

/**
 * Task snapshot. Task mutations belong exclusively to explicit commands/tools;
 * the only write is review state, through onReview.
 */
export async function showTodoBrowser(ctx: ExtensionContext, state: TodoState, options: TodoBrowserOptions = {}): Promise<void> {
  const now = options.now ?? Date.now();
  const history = options.activity && { activity: options.activity, review: options.review ?? createTodoReviewState(), now };
  const unreviewed = history ? unreviewedTodoTasks(state, history.activity, history.review) : new Map();
  const items = orderedTodoTasks(state).map((task): BrowserItem => {
    const presentation = todoTaskPresentation(task, state);
    const messages = history?.activity.get(task.key)?.updates.flatMap((update) => update.message ?? []) ?? [];
    const assignee = options.assignees?.get(task.key);
    return {
      id: task.key,
      label: `${task.key}: ${task.subject}${task.dependsOn?.length ? ` ← ${task.dependsOn.join(", ")}` : ""}${assignee ? ` → ${assignee}` : ""}`,
      status: presentation.label,
      badge: { label: `${presentation.glyph} ${presentation.label}`, color: presentation.color },
      ...(history ? { marker: unreviewed.has(task.key) } : {}),
      description: `${task.description ?? ""} ${task.status} ${(task.dependsOn ?? []).join(" ")} ${messages.join(" ")}${assignee ? ` ${assignee}` : ""}`,
      detail: todoTaskDetail(task, state, history, assignee).join("\n"),
    };
  });
  if (!history) {
    await showReadOnlyBrowser(ctx, { title: "Todos", note: "Read-only task snapshot", items });
    return;
  }
  const order = new Map(state.tasks.map((task, index) => [task.key, index]));
  const recent = state.tasks.map((task) => task.key).sort((a, b) =>
    (lastTodoActivityAt(b, history.activity) ?? -1) - (lastTodoActivityAt(a, history.activity) ?? -1)
    || order.get(a)! - order.get(b)!);
  // Each shown message is reviewed once, at the revision this snapshot displayed.
  const pending = new Map(unreviewed);
  const review = (keys: string[]) => {
    const marks = new Map<string, number>();
    for (const key of keys) {
      const update = pending.get(key);
      if (update) marks.set(key, update.revision);
      pending.delete(key);
    }
    if (marks.size) options.onReview?.(marks);
  };
  const reviewed = history.review.at;
  await showReadOnlyBrowser(ctx, {
    title: "Todos",
    note: `Read-only task snapshot · last reviewed ${reviewed === undefined ? "never" : formatTodoAge(reviewed, now)}`,
    items,
    views: [
      { label: "All", ids: items.map((item) => item.id) },
      { label: "Unreviewed", ids: [...unreviewed.keys()], empty: "No unreviewed messages. Tab for other views." },
      { label: "Recent", ids: recent },
    ],
    initialView: Math.max(0, TODO_VIEWS.indexOf(options.view ?? "all")),
    onOpen: (key) => review([key]),
    onReview: review,
  });
}
