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
import type { InsightItem, InsightView } from "./types.js";

const NOTHING: Component = { render: () => [], invalidate() {} };

type ViewerContext = Pick<ExtensionContext, "mode" | "hasUI" | "ui">;

/** Probe the renderer, not the fullscreen setting (which may be overridden). */
export async function showInsightView(ctx: ViewerContext, view: InsightView): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("System insights viewer requires TUI mode.", "warning");
    return;
  }
  // Capture before awaiting: this interaction is a read-only snapshot.
  const snapshot: InsightView = {
    ...view,
    items: view.items?.map((item) => ({ ...item, badge: item.badge && { ...item.badge } })),
    legend: view.legend?.map((entry) => ({ ...entry })),
  };
  const mode = await ctx.ui.custom<TUI["mode"] | undefined>((tui, _theme, _keys, done) => {
    done(tui.mode);
    return NOTHING;
  });
  await ctx.ui.custom<void>(
    (tui, theme, keys, done) => new InsightViewer({ tui, theme, keys, view: snapshot, done }),
    mode === "fullscreen"
      ? { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } }
      : { overlay: false },
  );
}

/** Remove terminal commands before layout; only trusted theme/Input ANSI is rendered.
 * Includes OSC hyperlinks/clipboard/title, CSI, DCS, APC (cursor markers), and C1 forms.
 * Incomplete string commands consume their remaining payload rather than executing it.
 */
export function sanitizeInsightText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[^]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\t/g, "    ");
}

export interface InsightViewerOptions {
  tui: Pick<TUI, "mode" | "requestRender"> & { terminal: Pick<TUI["terminal"], "rows" | "columns"> };
  theme: Pick<Theme, "fg" | "bold">;
  keys: Pick<KeybindingsManager, "matches" | "getKeys">;
  view: InsightView;
  done: (result: undefined) => void;
}

/** Bounded plain-text/list viewer. Owns no terminal, files, settings, or live data. */
export class InsightViewer implements Component, Focusable {
  focused = false;
  private readonly input: Input;
  private readonly view: InsightView;
  private readonly items: InsightItem[];
  private filtered: InsightItem[];
  private selected = 0;
  private detail: InsightItem | undefined;
  private offset = 0;
  private closed = false;
  private width: number;
  private layout: { width: number; text: string; lines: string[] } | undefined;

  constructor(private readonly options: InsightViewerOptions) {
    const cleanLine = (text: string) => sanitizeInsightText(text).replace(/\n/g, " ");
    this.view = {
      title: cleanLine(options.view.title),
      note: cleanLine(options.view.note),
      text: options.view.text === undefined ? undefined : sanitizeInsightText(options.view.text),
      legend: options.view.legend?.map((entry) => ({
        label: cleanLine(entry.label), color: entry.color, meaning: cleanLine(entry.meaning),
      })),
    };
    this.items = (options.view.items ?? []).map((item) => ({
      id: item.id,
      label: cleanLine(item.label),
      status: item.status === undefined ? undefined : cleanLine(item.status),
      badge: item.badge && { label: cleanLine(item.badge.label), color: item.badge.color },
      description: cleanLine(item.description),
      detail: sanitizeInsightText(item.detail),
    }));
    this.filtered = this.items;
    this.width = options.tui.terminal.columns;
    this.input = new Input({
      prompt: "Filter: ",
      placeholder: "type to search",
      placeholderStyle: (text) => options.theme.fg("dim", text),
    });
  }

  private get isList(): boolean {
    return this.view.text === undefined && !this.detail;
  }

  private title(): string {
    const root = this.view.title.startsWith("System insights")
      ? this.view.title : `System insights · ${this.view.title}`;
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
      hint = contentWidth >= 14 ? `Esc to ${this.detail ? "go back" : "close"}`
        : contentWidth >= 9 ? `Esc ${this.detail ? "back" : "close"}` : "Esc";
    }
    // Shorten before wrapping: both actions outrank lengthy paging labels.
    return wrapTextWithAnsi(hint, Math.max(1, contentWidth));
  }

  private legendText(): string {
    return (this.view.legend ?? []).map((entry) => `${entry.label}=${entry.meaning}`).join(" · ");
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
    const legend = wrapTextWithAnsi(this.legendText(), contentWidth);
    const legendRows = this.view.legend?.length && take(legend.length, 1) ? legend.length : 0;
    const position = take(1, 1);
    const innerY = frame && take(2, 2) ? 1 : 0;
    const outerY = frame && take(2, 2) ? 1 : 0;
    const note = !!this.view.note && take(1, 2);
    const navigation = wrapTextWithAnsi(
      `↑↓ ${this.isList ? "select" : "scroll"} · ${this.pageHints()} · Ctrl+C close`, contentWidth,
    );
    const navigationRows = take(navigation.length, 2) ? navigation.length : 0;
    const body = height ? remaining + 1 : 0;
    return {
      height, frame, outerX, innerX, borderWidth, contentWidth, innerY, outerY,
      filter, footerRows, divider, legendRows, position, note, navigationRows, body, core, navigation,
    };
  }

  private textLines(): string[] {
    const text = this.detail?.detail ?? this.view.text ?? "";
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
    } else if (this.isList && matchesKey(data, "enter")) {
      this.detail = this.filtered[this.selected];
      this.offset = 0;
    } else if (this.isList) {
      const before = this.input.getValue();
      this.input.handleInput(data);
      // Built-in Input accepts bracketed paste; scrub its untrusted contents too.
      const safe = sanitizeInsightText(this.input.getValue()).replace(/\n/g, " ");
      if (safe !== this.input.getValue()) this.input.setValue(safe);
      if (before !== safe) this.filter();
    }
    this.invalidate();
    this.options.tui.requestRender();
  }

  private filter(): void {
    const query = this.input.getValue().toLocaleLowerCase();
    this.filtered = this.items.filter((item) =>
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
  private itemRow(left: string, item: InsightItem, width: number, selected = false): string {
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
    if (g.note) lines.push(row(theme.fg("muted", this.view.note)));
    if (g.filter) lines.push(row(this.input.render(g.contentWidth)[0] ?? ""));
    let position: string;
    if (this.isList) {
      this.selected = Math.max(0, Math.min(this.selected, this.filtered.length - 1));
      const start = Math.max(0, Math.min(
        this.selected - Math.floor(g.body / 2), this.filtered.length - g.body,
      ));
      for (let i = 0; i < g.body; i++) {
        const index = start + i;
        const item = this.filtered[index];
        const prefix = index === this.selected ? "→ " : "  ";
        const text = item
          ? this.itemRow(`${prefix}${item.badge ? "Name: " : ""}${item.label}`, item, g.contentWidth, index === this.selected)
          : (!i && !this.filtered.length ? theme.fg("muted", "No matching items.") : "");
        lines.push(row(text));
      }
      position = `${this.filtered.length ? this.selected + 1 : 0}/${this.filtered.length} items · ${this.items.length} total`;
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
    if (g.legendRows) {
      const legend = (this.view.legend ?? []).map((entry) =>
        theme.fg(entry.color, entry.label) + theme.fg("dim", `=${entry.meaning}`),
      ).join(theme.fg("dim", " · "));
      for (const line of wrapTextWithAnsi(legend, g.contentWidth).slice(0, g.legendRows)) lines.push(row(line));
    }
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
