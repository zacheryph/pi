/** MIT adaptation of the bundle's read-only browsers; see ../LICENSE. */
import {
  Input,
  matchesKey,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { TextViewport, viewHeight, type DetailContent } from "./detail.ts";
import { ICONS } from "./icons.ts";
import { cells, layoutPanel, renderPanel, splitColumns, titleText } from "./layout.ts";
import { openModal, type ModalContext, type ModalOptions } from "./modal.ts";
import { navigationDelta, navigationHints } from "./navigation.ts";
import { sanitizeLine } from "./text.ts";
import type { Title, UIColor, UIKeys, UISurface, UITheme } from "./types.ts";

export interface ExplorerItem {
  /** Opaque identity, never rendered or normalized. */
  id: string;
  label: string;
  description?: string;
  status?: string;
  badge?: { label: string; color: UIColor };
  marker?: boolean;
  detail?: DetailContent;
}
export interface ExplorerTab {
  label: string;
  ids: readonly string[];
  emptyText?: string;
}
export interface ExplorerView {
  title: Title;
  items: readonly ExplorerItem[];
  note?: string;
  tabs?: readonly ExplorerTab[];
  initialTab?: number;
  legend?: readonly { label: string; meaning: string; color: UIColor }[];
  hints?: readonly string[];
  onOpen?: (id: string) => void;
  onReview?: (ids: string[]) => void;
  /** Called only on opening an item. Strings are sanitized; row renderers are trusted. */
  loadDetail?: (id: string, signal: AbortSignal) => DetailContent | Promise<DetailContent>;
}
export interface ExplorerOptions {
  tui: UISurface;
  theme: UITheme;
  keys: UIKeys;
  view: ExplorerView;
  done: () => void;
  heightFraction?: number;
}

export function snapshotExplorer(view: ExplorerView): ExplorerView {
  return {
    ...view,
    title: typeof view.title === "string" ? view.title : { ...view.title },
    items: view.items.map((item) => ({ ...item, badge: item.badge && { ...item.badge } })),
    tabs: view.tabs?.map((tab) => ({ ...tab, ids: [...tab.ids] })),
    legend: view.legend?.map((entry) => ({ ...entry })),
    hints: view.hints && [...view.hints],
  };
}

export class Explorer implements Component, Focusable {
  focused = false;
  private readonly view: ExplorerView;
  private readonly input: Input;
  private readonly viewport = new TextViewport();
  private readonly markerGutter: boolean;
  private filtered: ExplorerItem[] = [];
  private selected = 0;
  private tab: number;
  private detail?: ExplorerItem;
  private load?: AbortController;
  private width: number;
  private closed = false;

  constructor(private readonly options: ExplorerOptions) {
    this.view = snapshotExplorer(options.view);
    this.view.items = this.view.items.map((item) => ({
      ...item,
      label: sanitizeLine(item.label),
      description: sanitizeLine(item.description ?? ""),
      status: item.status && sanitizeLine(item.status),
      badge: item.badge && { ...item.badge, label: sanitizeLine(item.badge.label) },
    }));
    this.markerGutter = this.view.items.some((item) => item.marker);
    this.tab = Math.min(
      cells(this.view.initialTab ?? 0),
      Math.max(0, (this.view.tabs?.length ?? 1) - 1),
    );
    this.width = cells(options.tui.terminal.columns);
    this.input = new Input({
      prompt: "Filter: ",
      placeholder: "type to search",
      placeholderStyle: (text) => options.theme.fg("dim", text),
    });
    this.filter();
  }
  private tabItems(): readonly ExplorerItem[] {
    const tab = this.view.tabs?.[this.tab];
    if (!tab) return this.view.items;
    const byId = new Map(this.view.items.map((item) => [item.id, item]));
    return tab.ids.flatMap((id) => byId.get(id) ?? []);
  }
  private filter(): void {
    const query = this.input.getValue().toLocaleLowerCase();
    this.filtered = this.tabItems().filter((item) =>
      `${item.label} ${item.status ?? ""} ${item.description}`.toLocaleLowerCase().includes(query),
    );
    this.selected = 0;
  }
  private chrome() {
    const { theme, keys } = this.options;
    const before: string[] = [];
    const width = layoutPanel(this.width, this.height()).contentWidth;
    if (!this.detail) {
      before.push(width ? (this.input.render(width)[0] ?? "") : "");
      if ((this.view.tabs?.length ?? 0) > 1)
        before.push(
          this.view
            .tabs!.map((tab, i) =>
              theme.fg(i === this.tab ? "accent" : "dim", sanitizeLine(tab.label)),
            )
            .join(" · "),
        );
    }
    if (this.view.note) before.push(theme.fg("muted", sanitizeLine(this.view.note)));
    if (this.view.legend?.length)
      before.push(
        this.view.legend
          .map(
            (entry) =>
              theme.fg(entry.color, sanitizeLine(entry.label)) + "=" + sanitizeLine(entry.meaning),
          )
          .join(" · "),
      );
    const actions = this.detail
      ? "Esc back · Ctrl+C close"
      : "Enter details · Esc clear/close · Ctrl+C close";
    const navigation = [
      navigationHints(keys),
      !this.detail && (this.view.tabs?.length ?? 0) > 1 ? "Tab/Shift+Tab view" : "",
      !this.detail && this.view.onReview ? "Ctrl+R review" : "",
      ...(this.view.hints ?? []).map(sanitizeLine),
    ]
      .filter(Boolean)
      .join(" · ");
    const after = [theme.fg("dim", actions), "", theme.fg("dim", navigation)];
    return { before, after };
  }
  private height(): number {
    return viewHeight(this.options.tui.terminal.rows, this.options.heightFraction);
  }
  private geometry() {
    const chrome = this.chrome();
    return {
      ...chrome,
      layout: layoutPanel(this.width, this.height(), chrome.before.length, chrome.after.length),
    };
  }
  private move(delta: number): void {
    if (Number.isNaN(delta)) return;
    if (this.detail) {
      const { layout } = this.geometry();
      this.viewport.move(delta, layout.contentWidth, layout.bodyRows);
    } else
      this.selected = Math.max(
        0,
        Math.min(Math.max(0, this.filtered.length - 1), Math.trunc(this.selected + delta)),
      );
  }
  private openSelected(): void {
    const item = this.filtered[this.selected];
    if (!item) return;
    this.detail = item;
    this.view.onOpen?.(item.id);
    item.marker = false;
    this.load?.abort();
    if (!this.view.loadDetail) {
      this.viewport.setContent(item.detail ?? "");
      return;
    }
    const controller = new AbortController();
    this.load = controller;
    this.viewport.setContent("Loading…");
    // Capture errors from synchronous loaders too, and reject stale results even when reopening the same id.
    void Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) return "";
        return this.view.loadDetail!(item.id, controller.signal);
      })
      .then(
        (content) => {
          if (!controller.signal.aborted && !this.closed) {
            this.viewport.setContent(content);
            this.options.tui.requestRender();
          }
        },
        (error: unknown) => {
          if (!controller.signal.aborted && !this.closed) {
            this.viewport.setContent(`Unable to load: ${String(error)}`);
            this.options.tui.requestRender();
          }
        },
      );
  }
  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, "ctrl+c")) {
      this.close();
      return;
    }
    const delta = navigationDelta(data, this.options.keys, this.geometry().layout.bodyRows);
    if (matchesKey(data, "escape")) {
      if (this.detail) {
        this.load?.abort();
        this.detail = undefined;
      } else if (this.input.getValue()) {
        this.input.setValue("");
        this.filter();
      } else {
        this.close();
        return;
      }
    } else if (delta !== undefined) this.move(delta);
    else if (!this.detail) {
      const tabs = this.view.tabs;
      if (tabs?.length && (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))) {
        this.tab = (this.tab + (matchesKey(data, "tab") ? 1 : -1) + tabs.length) % tabs.length;
        this.filter();
      } else if (matchesKey(data, "ctrl+r") && this.view.onReview) {
        const marked = this.filtered.filter((item) => item.marker);
        if (marked.length) {
          this.view.onReview(marked.map((item) => item.id));
          for (const item of marked) item.marker = false;
        }
      } else if (matchesKey(data, "enter")) this.openSelected();
      else {
        const before = this.input.getValue();
        this.input.handleInput(data);
        const safe = sanitizeLine(this.input.getValue());
        if (safe !== this.input.getValue()) this.input.setValue(safe);
        if (safe !== before) this.filter();
      }
    }
    this.input.invalidate();
    this.options.tui.requestRender();
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed || this.options.tui.mode !== "fullscreen" || event.type !== "wheel")
      return undefined;
    this.move(event.wheelDelta ?? 0);
    this.options.tui.requestRender();
    return { handled: true };
  }
  render(width: number): string[] {
    if (this.closed) return [];
    this.width = cells(width);
    const { layout, before, after } = this.geometry(),
      { theme } = this.options;
    this.input.focused =
      this.focused && !this.detail && layout.beforeRows > 0 && layout.contentWidth > 0;
    // Re-render Input after assigning its focus so Pi's cursor marker survives panel composition.
    if (!this.detail && layout.contentWidth)
      before[0] = this.input.render(layout.contentWidth)[0] ?? "";
    let body: string[],
      title = titleText(this.view.title);
    if (this.detail) {
      title += ` / ${this.detail.label}`;
      body = this.viewport.render(layout.contentWidth, layout.bodyRows);
      const position = this.viewport.position(layout.contentWidth, layout.bodyRows);
      after[1] = theme.fg("dim", `${position.start}–${position.end}/${position.total} lines`);
    } else {
      const start = Math.max(
        0,
        Math.min(
          this.selected - Math.floor(layout.bodyRows / 2),
          this.filtered.length - layout.bodyRows,
        ),
      );
      body = this.filtered.slice(start, start + layout.bodyRows).map((item, i) => {
        const selected = start + i === this.selected;
        const marker = this.markerGutter ? (item.marker ? `${ICONS.marker} ` : "  ") : "";
        const left = `${selected ? ICONS.selected : " "} ${marker}${item.label}`;
        const right = item.badge?.label ?? item.status ?? "";
        return splitColumns(
          theme.fg(selected ? "accent" : "text", left),
          theme.fg(item.badge?.color ?? "dim", right),
          layout.contentWidth,
        );
      });
      if (!body.length && layout.bodyRows)
        body.push(
          theme.fg(
            "muted",
            sanitizeLine(
              this.input.getValue()
                ? "No matching items."
                : (this.view.tabs?.[this.tab]?.emptyText ?? "No items."),
            ),
          ),
        );
      after[1] = theme.fg(
        "dim",
        `${this.filtered.length ? this.selected + 1 : 0}/${this.filtered.length} items · ${this.view.items.length} total`,
      );
    }
    return renderPanel(layout, title, body, theme, { before, after });
  }
  invalidate(): void {
    this.input.invalidate();
    this.viewport.invalidate();
  }
  private close(): void {
    if (!this.closed) {
      this.dispose();
      this.options.done();
    }
  }
  dispose(): void {
    this.closed = true;
    this.load?.abort();
  }
}

export async function showExplorer(
  ctx: ModalContext,
  view: ExplorerView,
  options?: ModalOptions,
): Promise<void> {
  const snapshot = snapshotExplorer(view);
  await openModal<void>(
    ctx,
    (tui, theme, keys, done) =>
      new Explorer({ tui, theme, keys, view: snapshot, done: () => done(undefined) }),
    options,
  );
}
