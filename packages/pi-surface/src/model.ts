import type { JsonObject, JsonValue } from "#src/json";

// Every model type is a type alias, not an interface, so models are assignable to `JsonValue`.

/**
 * Semantic tones. Extensions say what text means; each renderer alone decides
 * how a tone looks, so every view shares one palette and selection rule.
 */
export type Tone = "default" | "accent" | "muted" | "dim" | "success" | "warning" | "error";
/** Untrusted plain text, optionally toned. Never pre-styled ANSI. */
export type Span = string | { text: string; tone?: Tone; bold?: boolean };
/** One logical line made of spans. */
export type Line = Span | readonly Span[];
/** Right-column label, e.g. a status. */
export type Badge = { text: string; tone?: Tone };
/** Plain text. `detail` renders as a breadcrumb: `icon  label / detail`. */
export type Title = string | { label: string; icon?: string; detail?: string };

/**
 * Behaviour in a view model: the id of an action registered on the session's
 * bus (see `defineAction`), and its arguments. A view model is JSON; behaviour
 * is an action reference, never a function.
 */
export type ActionRef<Args extends JsonValue = JsonValue> = { action: string; args?: Args };

/**
 * Structured detail content. All text is untrusted plain text; the renderer owns
 * styling, wrapping and spacing so every detail view reads the same way.
 */
export type Block =
  /** Section heading; a blank row precedes every heading but the first row. */
  | { heading: string }
  /** Aligned `label  value` rows; values wrap under themselves. */
  | { fields: readonly (readonly [label: string, value: Line])[] }
  /** Free text; newlines are kept and long lines wrap. */
  | { text: string; tone?: Tone }
  | { bullets: readonly string[] }
  /** Preformatted lines, e.g. a file preview; optionally numbered from `numbered`. */
  | { lines: readonly string[]; numbered?: boolean | number };
/** A plain string is shorthand for one text block. */
export type DetailContent = string | readonly Block[];

/** A standalone detail view. */
export type DetailModel = { title: Title; content: DetailContent };

/**
 * Footer hint. Lower priority numbers are more important; when hints do not fit,
 * the highest number is dropped first. Priority 0 is never dropped.
 */
export type Hint = { keys: string; action?: string; priority?: number };

export type WidgetRow = {
  left: Line;
  /** Ordered right-column fallbacks; the first that fits is shown. */
  right?: readonly Line[];
  /** At narrow widths keep the last right fallback and clip the left instead. */
  keepRight?: boolean;
  /** Category counted in the overflow row: `+3 more (2 running, 1 finished)`. */
  group?: string;
};
/** A compact heading with rows. Row budgets belong to the renderer (pi-ui's `WidgetView`). */
export type WidgetModel = {
  title: Title;
  /** Accent heading while active, dim while idle. Default true. */
  active?: boolean;
  /** Ordered fallbacks shown at the right of the heading rule; dropped before the title clips. */
  meta?: readonly Line[];
  rows: readonly WidgetRow[];
  emptyText?: string;
};

export type ExplorerItem = {
  /** Opaque identity, never rendered or normalized. */
  id: string;
  label: Line;
  /** Extra searchable text that is not displayed. */
  search?: string;
  /** Right column in the list, and beside the label in the detail header. */
  badge?: Badge;
  /** Shown in the marker column while the view has a `marker`. */
  marked?: boolean;
  detail?: DetailContent;
};
export type ExplorerTab = { label: string; ids: readonly string[]; emptyText?: string };
export type ExplorerMarker = {
  /** What a mark means, counted in the status row: "unreviewed". */
  label: string;
  /** Hint for clearing marks, e.g. "mark reviewed". Present only with `onClear`. */
  clearAction?: string;
  /** Dispatched with the reference's arguments plus `{ ids }` when marks are cleared. */
  onClear?: ActionRef<JsonObject>;
};
/** A filterable list of items that open into detail content. */
export type ExplorerModel = {
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
  /** Extension hints, e.g. related commands. */
  hints?: readonly Hint[];
  /** Dispatched with the reference's arguments plus `{ id }` when an item opens. */
  onOpen?: ActionRef<JsonObject>;
  /**
   * Dispatched with the reference's arguments plus `{ id }` when an item opens;
   * resolves to its `DetailContent` and supersedes `item.detail`.
   */
  loadDetail?: ActionRef<JsonObject>;
};

const TONES = new Set<unknown>([
  "default",
  "accent",
  "muted",
  "dim",
  "success",
  "warning",
  "error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const optional = (value: unknown, check: (value: unknown) => boolean) =>
  value === undefined || check(value);
const isString = (value: unknown) => typeof value === "string";
const isTone = (value: unknown) => TONES.has(value);
const isStrings = (value: unknown) => Array.isArray(value) && value.every(isString);

export function isSpan(value: unknown): value is Span {
  if (typeof value === "string") return true;
  return (
    isRecord(value) &&
    isString(value.text) &&
    optional(value.tone, isTone) &&
    optional(value.bold, (bold) => typeof bold === "boolean")
  );
}
export function isLine(value: unknown): value is Line {
  return isSpan(value) || (Array.isArray(value) && value.every(isSpan));
}
export function isBlock(value: unknown): value is Block {
  if (!isRecord(value)) return false;
  if ("heading" in value) return isString(value.heading);
  if ("fields" in value)
    return (
      Array.isArray(value.fields) &&
      value.fields.every(
        (field) =>
          Array.isArray(field) && field.length === 2 && isString(field[0]) && isLine(field[1]),
      )
    );
  if ("text" in value) return isString(value.text) && optional(value.tone, isTone);
  if ("bullets" in value) return isStrings(value.bullets);
  if ("lines" in value)
    return (
      isStrings(value.lines) &&
      optional(value.numbered, (n) => typeof n === "boolean" || typeof n === "number")
    );
  return false;
}
/** For content that arrives as data, such as an action's result. */
export function isDetailContent(value: unknown): value is DetailContent {
  return typeof value === "string" || (Array.isArray(value) && value.every(isBlock));
}
export function isActionRef(value: unknown): value is ActionRef {
  return isRecord(value) && isString(value.action);
}
