/** MIT adaptation of the bundle's read-only browsers; see ../LICENSE. */
import { errorText } from "#foundations/errors";
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
} from "#src/detail";
import { ICONS } from "#src/icons";
import { cells, layoutPanel, renderPanel, splitColumns } from "#src/layout";
import { openModal, type ModalContext, type ModalOptions } from "#src/modal";
import { HINT_PRIORITY, navigationDelta, navigationHint, type Hint } from "#src/navigation";
import { copyLine, paint, plainText, styleBadge, styleLine } from "#src/style";
import { sanitizeLine } from "#src/text";
import type { UIKeys, UISurface, UITheme } from "#src/types";
import {
  dispatchAction,
  isDetailContent,
  type ActionBus,
  type ActionRef,
  type ExplorerItem,
  type ExplorerMarker as MarkerModel,
  type ExplorerModel,
  type JsonObject,
} from "#surface";

export type { ExplorerItem, ExplorerModel, ExplorerTab } from "#surface";

/** Either form of behaviour: a callback, or a reference to an action on the session's bus. */
type Behaviour<Fn> = Fn | ActionRef<JsonObject>;

export interface ExplorerMarker extends Omit<MarkerModel, "onClear"> {
  /**
   * Opening a marked item, or Ctrl+R on the filtered list, clears marks locally
   * and reports them: a callback gets the ids, an action gets `{ ids }`.
   */
  onClear?: Behaviour<(ids: string[]) => void>;
}
/** pi-surface's explorer model, whose behaviour may also be callbacks. */
export interface ExplorerView extends Omit<ExplorerModel, "marker" | "onOpen" | "loadDetail"> {
  marker?: ExplorerMarker;
  onOpen?: Behaviour<(id: string) => void>;
  /**
   * Called only on opening an item; supersedes `item.detail`. An action gets
   * `{ id }` and must resolve to `DetailContent`.
   */
  loadDetail?: Behaviour<
    (id: string, signal: AbortSignal) => DetailContent | Promise<DetailContent>
  >;
}
export interface ExplorerOptions {
  tui: UISurface;
  theme: UITheme;
  keys: UIKeys;
  view: ExplorerView;
  done: () => void;
  heightFraction?: number;
  /** The session's bus (`pi.events`) that resolves the view's action references. */
  actions?: ActionBus;
}

function copyBehaviour<Fn>(behaviour: Behaviour<Fn>): Behaviour<Fn>;
function copyBehaviour<Fn>(behaviour: Behaviour<Fn> | undefined): Behaviour<Fn> | undefined;
function copyBehaviour<Fn>(behaviour: Behaviour<Fn> | undefined): Behaviour<Fn> | undefined {
  return typeof behaviour === "object" && behaviour !== null
    ? (structuredClone(behaviour) as ActionRef<JsonObject>)
    : behaviour;
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
    marker: view.marker && { ...view.marker, onClear: copyBehaviour(view.marker.onClear) },
    hints: view.hints?.map((hint) => ({ ...hint })),
    onOpen: copyBehaviour(view.onOpen),
    loadDetail: copyBehaviour(view.loadDetail),
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
  /** Resolve an action reference through the session's bus, adding the call's context to its arguments. */
  private dispatch(ref: ActionRef<JsonObject>, context: JsonObject): Promise<unknown> {
    const bus = this.options.actions;
    if (!bus) return Promise.reject(new Error(`no action registry for "${ref.action}"`));
    return dispatchAction(bus, ref.action, { ...ref.args, ...context });
  }
  /** Callbacks report synchronously; an action's failure has nowhere to show and is dropped. */
  private notify<Args extends unknown[]>(
    behaviour: Behaviour<(...args: Args) => void> | undefined,
    context: JsonObject,
    ...args: Args
  ): void {
    if (typeof behaviour === "function") behaviour(...args);
    else if (behaviour) this.dispatch(behaviour, context).catch(() => {});
  }
  private clearMarks(ids: string[]): void {
    const cleared = ids.filter((id) => this.marked.delete(id));
    if (cleared.length && this.view.marker)
      this.notify(this.view.marker.onClear, { ids: cleared }, cleared);
  }
  private loadDetail(id: string, signal: AbortSignal): DetailContent | Promise<DetailContent> {
    const load = this.view.loadDetail!;
    if (typeof load === "function") return load(id, signal);
    return this.dispatch(load, { id }).then((content) => {
      if (!isDetailContent(content))
        throw new Error(`action "${load.action}" returned no detail content`);
      return content;
    });
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
    this.notify(this.view.onOpen, { id: item.id }, item.id);
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
        return this.loadDetail(item.id, controller.signal);
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

export interface ShowExplorerOptions extends ModalOptions {
  /** The session's bus (`pi.events`) that resolves the view's action references. */
  actions?: ActionBus;
}

export async function showExplorer(
  ctx: ModalContext,
  view: ExplorerView | (() => ExplorerView),
  options?: ShowExplorerOptions,
): Promise<void> {
  const snapshot = typeof view === "function" ? view : snapshotExplorer(view);
  const { actions, ...modal } = options ?? {};
  await openModal<void>(
    ctx,
    (tui, theme, keys, done) =>
      new Explorer({
        tui,
        theme,
        keys,
        view: typeof snapshot === "function" ? snapshot() : snapshot,
        done: () => done(undefined),
        actions,
      }),
    options && modal,
  );
}
