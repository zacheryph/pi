import { ACTION_ID, type ActionBus } from "#src/actions";
import { isJsonValue } from "#src/json";
import type { DetailModel, ExplorerModel, WidgetModel } from "#src/model";

/**
 * The bus channel that carries list and read requests for views. Like actions,
 * a view is a listener on the session's bus, not an entry in a shared object.
 */
export const VIEWS_CHANNEL = "surface:views";
/** Announced by a provider whenever its model may have changed: `{ version, id }`. */
export const VIEW_CHANGED_EVENT = "surface:view-changed";
export const VIEWS_VERSION = 1;

/** `<extension>.<view>`, the same shape as an action id, e.g. `todo.widget`. */
export const VIEW_ID = ACTION_ID;

export type ViewKind = "widget" | "explorer" | "detail";
export const VIEW_KINDS: readonly ViewKind[] = ["widget", "explorer", "detail"];

export type ViewModel = WidgetModel | ExplorerModel | DetailModel;
export type ViewModelOf<Kind extends ViewKind> = {
  widget: WidgetModel;
  explorer: ExplorerModel;
  detail: DetailModel;
}[Kind];

export interface ViewInfo {
  id: string;
  kind: ViewKind;
  title: string;
}

export interface ViewDefinition<Kind extends ViewKind = ViewKind> extends ViewInfo {
  kind: Kind;
  /**
   * The current model, built when a consumer reads it. `undefined` means the
   * view has nothing to show right now (a widget the terminal would hide).
   */
  model: () => ViewModelOf<Kind> | undefined;
}

export interface ViewChangedEvent {
  version: typeof VIEWS_VERSION;
  id: string;
}

type ViewRequest = { version: typeof VIEWS_VERSION } & (
  | { kind: "list"; add(info: ViewInfo): void }
  | { kind: "read"; id: string; respond(read: () => unknown): void }
);

function request(bus: ActionBus, data: ViewRequest): void {
  bus.emit(VIEWS_CHANNEL, data);
}

/** Views defined on this bus, sorted by id. */
export function listViews(bus: ActionBus): ViewInfo[] {
  const found: ViewInfo[] = [];
  request(bus, { version: VIEWS_VERSION, kind: "list", add: (info) => found.push(info) });
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Define a view on this session's bus and announce it. Throws for a malformed
 * id, an unknown kind, an empty title, or an id already defined on the bus.
 * Returns the function that removes it.
 */
export function defineView<Kind extends ViewKind>(
  bus: ActionBus,
  definition: ViewDefinition<Kind>,
): () => void {
  const { id, kind, title, model } = definition;
  if (typeof id !== "string" || !VIEW_ID.test(id))
    throw new Error(
      `Invalid view id "${String(id)}": use lowercase <extension>.<view>, e.g. "todo.widget".`,
    );
  if (!VIEW_KINDS.includes(kind))
    throw new Error(`View "${id}" has unknown kind "${String(kind)}".`);
  if (typeof title !== "string" || !title.trim()) throw new Error(`View "${id}" needs a title.`);
  if (typeof model !== "function") throw new Error(`View "${id}" needs a model function.`);
  if (listViews(bus).some((view) => view.id === id))
    throw new Error(`View "${id}" is already defined on this session.`);
  const off = bus.on(VIEWS_CHANNEL, (data) => {
    const req = data as ViewRequest | null | undefined;
    if (req?.version !== VIEWS_VERSION) return;
    if (req.kind === "list") req.add({ id, kind, title });
    // The reader builds the model outside the emit, so a throwing provider cannot break the bus.
    else if (req.kind === "read" && req.id === id) req.respond(model);
  });
  announceView(bus, id);
  return off;
}

/**
 * The current model of a view defined on this bus, or `undefined` while it has
 * nothing to show. Throws for an unknown id, with the provider's own error, and
 * for a model that is not JSON.
 */
export function readView(bus: ActionBus, id: string): ViewModel | undefined {
  let read: (() => unknown) | undefined;
  request(bus, {
    version: VIEWS_VERSION,
    kind: "read",
    id,
    respond: (value) => {
      read ??= value;
    },
  });
  if (!read) throw new Error(`Unknown view "${id}".`);
  const model = read();
  if (model === undefined) return undefined;
  if (!isJsonValue(model) || typeof model !== "object" || model === null || Array.isArray(model))
    throw new Error(`View "${id}" returned a model that is not JSON.`);
  return model as ViewModel;
}

/** Tell consumers that this view's model may have changed; they read it again when they need it. */
export function announceView(bus: ActionBus, id: string): void {
  bus.emit(VIEW_CHANGED_EVENT, { version: VIEWS_VERSION, id } satisfies ViewChangedEvent);
}

/** Calls `listener` with the id of each view that announces a change. Returns the unsubscribe. */
export function onViewChanged(bus: ActionBus, listener: (id: string) => void): () => void {
  return bus.on(VIEW_CHANGED_EVENT, (data) => {
    const event = data as Partial<ViewChangedEvent> | null | undefined;
    if (event?.version === VIEWS_VERSION && typeof event.id === "string") listener(event.id);
  });
}

export interface ViewRegistry {
  /** Define a view; it is removed by the returned function or by `dispose`. */
  define<Kind extends ViewKind>(definition: ViewDefinition<Kind>): () => void;
  list(): ViewInfo[];
  read(id: string): ViewModel | undefined;
  /**
   * Announce that one of this registry's views may have changed. Does nothing
   * for an id it does not define, so a late call after `dispose` never touches
   * a bus that Pi has already retired.
   */
  changed(id: string): void;
  /** Remove every view this registry defined. Call it from `session_shutdown`. */
  dispose(): void;
}

/** A handle on one session's bus that remembers what it defined, so one call removes it all. */
export function viewRegistry(bus: ActionBus): ViewRegistry {
  const owned = new Map<string, () => void>();
  return {
    define(definition) {
      const remove = defineView(bus, definition);
      const dispose = () => {
        if (owned.get(definition.id) !== dispose) return;
        owned.delete(definition.id);
        remove();
      };
      owned.set(definition.id, dispose);
      return dispose;
    },
    list: () => listViews(bus),
    read: (id) => readView(bus, id),
    changed: (id) => {
      if (owned.has(id)) announceView(bus, id);
    },
    dispose() {
      // Each dispose deletes its own entry; deleting the current entry is safe while iterating a Map.
      for (const dispose of owned.values()) dispose();
    },
  };
}
