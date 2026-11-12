/** MIT adaptation of the bundle's read-only browsers; see ../LICENSE. */
import { errorText } from "../../pi-foundations/src/errors.ts";
import {
  Input,
  matchesKey,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  copyContent,
  footerRows,
  positionText,
  renderDetail,
  TextViewport,
  viewHeight,
  type DetailContent,
} from "./detail.ts";
import { ICONS } from "./icons.ts";
import { cells, layoutPanel, renderPanel, splitColumns } from "./layout.ts";
import { openModal, type ModalContext, type ModalOptions } from "./modal.ts";
import { HINT_PRIORITY, navigationDelta, navigationHint, type Hint } from "./navigation.ts";
import {
  copyLine,
  paint,
  plainText,
  styleBadge,
  styleLine,
  type Badge,
  type Line,
} from "./style.ts";
import { sanitizeLine } from "./text.ts";
import type { Title, UIKeys, UISurface, UITheme } from "./types.ts";

export interface ExplorerItem {
  /** Opaque identity, never rendered or normalized. */
  id: string;
  label: Line;
  /** Extra searchable text that is not displayed. */
  search?: string;
  /** Right column in the list, and beside the label in the detail header. */
  badge?: Badge;
  /** Shown in the marker column while `ExplorerView.marker` is set. */
  marked?: boolean;
  detail?: DetailContent;
}
export interface ExplorerTab {
  label: string;
  ids: readonly string[];
  emptyText?: string;
}
export interface ExplorerMarker {
  /** What a mark means, counted in the status row: "unreviewed". */
  label: string;
  /** Ctrl+R hint, e.g. "mark reviewed". Present only with `onClear`. */
  clearAction?: string;
  /** Opening a marked item, or Ctrl+R on the filtered list, clears marks locally and reports them. */
  onClear?: (ids: string[]) => void;
}
export interface ExplorerView {
  title: Title;
  items: readonly ExplorerItem[];
  /** Counted noun for the status row and empty states. Default `["item", "items"]`. */
  noun?: readonly [singular: string, plural: string];
  /** One row each above the list, e.g. a scope note, warning or legend. */
  notices?: readonly Line[];
  tabs?: readonly ExplorerTab[];
  initialTab?: number;
  marker?: ExplorerMarker;
  /** Empty-list text when no tab supplies its own. */
  emptyText?: string;
  /** Extension hints, e.g. related commands. Default priority `HINT_PRIORITY.extension`. */
  hints?: readonly Hint[];
  onOpen?: (id: string) => void;
  /** Called only on opening an item; supersedes `item.detail`. */
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
    items: view.items.map((item) => ({
      ...item,
      label: copyLine(item.label),
      badge: item.badge && { ...item.badge },
      detail: item.detail === undefined ? undefined : copyContent(item.detail),
    })),
    noun: view.noun && [view.noun[0], view.noun[1]],
    notices: view.notices?.map(copyLine),
    tabs: view.tabs?.map((tab) => ({ ...tab, ids: [...tab.ids] })),
    marker: view.marker && { ...view.marker },
    hints: view.hints?.map((hint) => ({ ...hint })),
  };
}

export class Explorer implements Component, Focusable {
  focused = false;
  private readonly view: ExplorerView;
  private readonly input: Input;
  private readonly viewport = new TextViewport();
  private readonly marked = new Set<string>();
  private readonly search = new Map<string, string>();
  private filtered: ExplorerItem[] = [];
  private selected = 0;
  private tab: number;
  private detail?: ExplorerItem;
  private load?: AbortController;
  private width: number;
  private closed = false;

  constructor(private readonly options: ExplorerOptions) {
    this.view = snapshotExplorer(options.view);
    for (const item of this.view.items) {
      if (item.marked) this.marked.add(item.id);
      this.search.set(
        item.id,
        [
          plainText(item.label),
          sanitizeLine(item.badge?.text ?? ""),
          sanitizeLine(item.search ?? ""),
        ]
          .join(" ")
          .toLocaleLowerCase(),
      );
    }
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
  private get plural(): string {
    return sanitizeLine(this.view.noun?.[1] ?? "items");
  }
  private tabItems(): readonly ExplorerItem[] {
    const tab = this.view.tabs?.[this.tab];
    if (!tab) return this.view.items;
    const byId = new Map(this.view.items.map((item) => [item.id, item]));
    return tab.ids.flatMap((id) => byId.get(id) ?? []);
  }
  private filter(): void {
    const query = this.input.getValue().toLocaleLowerCase();
    this.filtered = this.tabItems().filter((item) => this.search.get(item.id)!.includes(query));
    this.selected = 0;
  }
  private clearMarks(ids: string[]): void {
    const cleared = ids.filter((id) => this.marked.delete(id));
    if (cleared.length && this.view.marker) this.view.marker.onClear?.(cleared);
  }
  private hints(): Hint[] {
    const { marker, tabs } = this.view;
    const actions: Hint[] = this.detail
      ? [{ keys: "Esc", action: "back", priority: HINT_PRIORITY.action }]
      : [
          { keys: "Enter", action: "open", priority: HINT_PRIORITY.action },
          {
            keys: "Esc",
            action: this.input.getValue() ? "clear filter" : "close",
            priority: HINT_PRIORITY.action,
          },
          ...((tabs?.length ?? 0) > 1
            ? [{ keys: "Tab", action: "view", priority: HINT_PRIORITY.view }]
            : []),
          ...(marker?.onClear
            ? [
                {
                  keys: "Ctrl+R",
                  action: marker.clearAction ?? "clear marks",
                  priority: HINT_PRIORITY.view,
                },
              ]
            : []),
        ];
    return [
      ...actions,
      ...(this.view.hints ?? []).map((hint) => ({
        ...hint,
        priority: hint.priority ?? HINT_PRIORITY.extension,
      })),
      navigationHint(this.options.keys),
    ];
  }
  private status(): string {
    if (this.detail) {
      const { layout } = this.geometry();
      return positionText(this.viewport.position(layout.contentWidth, layout.bodyRows));
    }
    const shown = this.filtered.length,
      total = this.view.items.length;
    const parts = [
      `${shown ? this.selected + 1 : 0}/${shown} ${shown === 1 ? sanitizeLine(this.view.noun?.[0] ?? "item") : this.plural}`,
    ];
    if (shown !== total) parts.push(`${total} total`);
    if (this.view.marker && this.marked.size)
      parts.push(`${this.marked.size} ${sanitizeLine(this.view.marker.label)}`);
    return parts.join(" · ");
  }
  private chrome(contentWidth: number, status: string) {
    const { theme } = this.options;
    const before: string[] = [];
    if (!this.detail) {
      before.push(contentWidth ? (this.input.render(contentWidth)[0] ?? "") : "");
      if ((this.view.tabs?.length ?? 0) > 1)
        before.push(
          this.view
            .tabs!.map((tab, i) =>
              paint(
                theme,
                i === this.tab ? "accent" : "dim",
                sanitizeLine(tab.label),
                i === this.tab,
              ),
            )
            .join(paint(theme, "dim", " · ")),
        );
    }
    for (const notice of this.view.notices ?? []) before.push(styleLine(notice, theme));
    const after = footerRows(status, this.hints(), contentWidth, theme);
    return { before, after };
  }
  private height(): number {
    return viewHeight(this.options.tui.terminal.rows, this.options.heightFraction);
  }
  private geometry(status = "") {
    const { contentWidth } = layoutPanel(this.width, this.height());
    const chrome = this.chrome(contentWidth, status);
    const layout = layoutPanel(
      this.width,
      this.height(),
      chrome.before.length,
      chrome.after.length,
    );
    return { ...chrome, layout };
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
  private showDetail(item: ExplorerItem, content: DetailContent): void {
    const snapshot = copyContent(content);
    this.viewport.setContent((width) =>
      renderDetail(snapshot, width, this.options.theme, { label: item.label, badge: item.badge }),
    );
  }
  private openSelected(): void {
    const item = this.filtered[this.selected];
    if (!item) return;
    this.detail = item;
    this.view.onOpen?.(item.id);
    this.clearMarks([item.id]);
    this.load?.abort();
    if (!this.view.loadDetail) {
      this.showDetail(item, item.detail ?? "");
      return;
    }
    const controller = new AbortController();
    this.load = controller;
    this.showDetail(item, [{ text: "Loading…", tone: "muted" }]);
    // Capture errors from synchronous loaders too, and reject stale results even when reopening the same id.
    void Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) return "";
        return this.view.loadDetail!(item.id, controller.signal);
      })
      .then(
        (content) => {
          if (!controller.signal.aborted && !this.closed) {
            this.showDetail(item, content);
            this.options.tui.requestRender();
          }
        },
        (error: unknown) => {
          if (!controller.signal.aborted && !this.closed) {
            this.showDetail(item, [{ text: `Couldn't load: ${errorText(error)}`, tone: "error" }]);
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
      } else if (matchesKey(data, "ctrl+r") && this.view.marker?.onClear) {
        this.clearMarks(this.filtered.map((item) => item.id));
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
    if (this.closed || event.type !== "wheel") return undefined;
    this.move(event.wheelDelta ?? 0);
    this.options.tui.requestRender();
    return { handled: true };
  }
  private row(item: ExplorerItem, selected: boolean, width: number): string {
    const { theme } = this.options;
    const pointer = selected ? paint(theme, "accent", ICONS.selected) + " " : "  ";
    const gutter = this.view.marker
      ? this.marked.has(item.id)
        ? paint(theme, "accent", ICONS.marker) + " "
        : "  "
      : "";
    const label = styleLine(item.label, theme, selected ? { tone: "accent" } : {});
    return splitColumns(pointer + gutter + label, styleBadge(item.badge, theme), width, {
      minLeftWidth: Math.min(12, width),
    });
  }
  render(width: number): string[] {
    if (this.closed) return [];
    this.width = cells(width);
    const { theme } = this.options;
    const { layout, before, after } = this.geometry(this.status());
    this.input.focused =
      this.focused && !this.detail && layout.beforeRows > 0 && layout.contentWidth > 0;
    // Re-render Input after assigning its focus so Pi's cursor marker survives panel composition.
    if (!this.detail && layout.contentWidth)
      before[0] = this.input.render(layout.contentWidth)[0] ?? "";
    let body: string[];
    const title =
      typeof this.view.title === "string" ? { label: this.view.title } : { ...this.view.title };
    if (this.detail) {
      title.detail = plainText(this.detail.label);
      body = this.viewport.render(layout.contentWidth, layout.bodyRows);
    } else {
      const start = Math.max(
        0,
        Math.min(
          this.selected - Math.floor(layout.bodyRows / 2),
          this.filtered.length - layout.bodyRows,
        ),
      );
      body = this.filtered
        .slice(start, start + layout.bodyRows)
        .map((item, i) => this.row(item, start + i === this.selected, layout.contentWidth));
      if (!body.length && layout.bodyRows) {
        const empty = this.input.getValue()
          ? `No matching ${this.plural}.`
          : (this.view.tabs?.[this.tab]?.emptyText ?? this.view.emptyText ?? `No ${this.plural}.`);
        body.push(paint(theme, "muted", sanitizeLine(empty)));
      }
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
  view: ExplorerView | (() => ExplorerView),
  options?: ModalOptions,
): Promise<void> {
  const snapshot = typeof view === "function" ? view : snapshotExplorer(view);
  await openModal<void>(
    ctx,
    (tui, theme, keys, done) =>
      new Explorer({
        tui,
        theme,
        keys,
        view: typeof snapshot === "function" ? snapshot() : snapshot,
        done: () => done(undefined),
      }),
    options,
  );
}
