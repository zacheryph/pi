import type { JsonObject, JsonValue } from "#src/json";

// Every model type is a type alias, not an interface, so models are assignable to `JsonValue`.
// This module has no runtime imports: the bb plugin loads it directly for its guards.

/**
 * Process-bound state, explained once for every `live` field in these models.
 *
 * `live` marks state that exists only while the Pi process that produced it
 * runs: a running tool or agent, a clock that ticks, a count of running things.
 * A view shown after that process has gone (a saved snapshot) settles it, using
 * only these markers: a renderer never guesses from an icon, a tone or text.
 * State that lives in the session file (a task's `in_progress` status, review
 * marks, finished-agent history, Git and stash records) is never `live`, even
 * where it shares an icon with runtime state, and survives settling unchanged.
 * Each `live` field says what settling does to it.
 */

/**
 * Semantic tones. Extensions say what text means; each renderer alone decides
 * how a tone looks, so every view shares one palette and selection rule.
 */
export type Tone = "default" | "accent" | "muted" | "dim" | "success" | "warning" | "error";
/**
 * A state a span can stand for. Renderers with icons draw their own for it; the
 * terminal draws the span's text (its glyph).
 */
export type StateIcon =
  | "pending"
  | "active"
  | "done"
  | "blocked"
  | "queued"
  | "waiting"
  | "failed"
  | "stopped";
/** Untrusted plain text, optionally toned. Never pre-styled ANSI. */
export type Span =
  | string
  | {
      text: string;
      tone?: Tone;
      bold?: boolean;
      /**
       * The span is this state's glyph: a renderer with an icon for the state may
       * draw the icon instead of `text`, which may be empty when only such a
       * renderer should show anything.
       */
      icon?: StateIcon;
      /**
       * The text is an elapsed clock (`mm:ss`) that started at this time, in
       * epoch milliseconds. A renderer that redraws on its own may keep it
       * running; one that does not draws the text as it is.
       */
      since?: number;
      /**
       * Process-bound (see the note at the top of this module): the span shows
       * the state of the running process. Settled, it loses `since`, so its
       * clock stops at its text, and an `icon` becomes `stopped`.
       */
      live?: true;
    };
/** One logical line made of spans. */
export type Line = Span | readonly Span[];
/** Right-column label, e.g. a status. */
export type Badge = {
  text: string;
  tone?: Tone;
  /**
   * Process-bound (see the note at the top of this module): the badge names
   * live process state, such as `running`. Settled, it is replaced by the badge
   * given here, or removed when the value is `true`.
   */
  live?: true | { text: string; tone?: Tone };
};
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
  /**
   * A short column before the row's text, such as an elapsed clock. The terminal
   * draws it two spaces before `left`; bb draws it after the row's state icon.
   */
  lead?: Line;
  left: Line;
  /** Ordered right-column fallbacks; the first that fits is shown. */
  right?: readonly Line[];
  /** At narrow widths keep the last right fallback and clip the left instead. */
  keepRight?: boolean;
  /** Category counted in the overflow row: `+3 more (2 running, 1 finished)`. */
  group?: string;
  /**
   * Process-bound (see the note at the top of this module): the row shows
   * something that runs only while the process does, such as a running agent.
   * Settled, each field given here replaces the row's own (for example a
   * `right` that reads "stopped" and a `group` of "stopped"); the spans left
   * in place settle by their own `live` marks. `true` changes no field.
   */
  live?: true | WidgetRowSettled;
};
/** What a process-bound widget row shows once its process has gone. */
export type WidgetRowSettled = {
  lead?: Line;
  left?: Line;
  right?: readonly Line[];
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

export const STATE_ICONS: readonly StateIcon[] = [
  "pending",
  "active",
  "done",
  "blocked",
  "queued",
  "waiting",
  "failed",
  "stopped",
];

const TONES = new Set<unknown>([
  "default",
  "accent",
  "muted",
  "dim",
  "success",
  "warning",
  "error",
]);
/** Same shape as an action id (`#src/actions`), repeated so this module needs no runtime import. */
const ACTION_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

// Kept local, rather than imported from `#src/guards`, so this module has no runtime imports.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const optional = (value: unknown, check: (value: unknown) => boolean) =>
  value === undefined || check(value);
const isString = (value: unknown) => typeof value === "string";
const isBoolean = (value: unknown) => typeof value === "boolean";
const isFinite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
export const isTone = (value: unknown): value is Tone => TONES.has(value);
const isStrings = (value: unknown) => Array.isArray(value) && value.every(isString);
const isArrayOf = (value: unknown, check: (value: unknown) => boolean) =>
  Array.isArray(value) && value.every(check);
const isLines = (value: unknown) => isArrayOf(value, isLine);
/** Plain JSON data: finite numbers, plain objects and arrays, no cycles. */
function isJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || isString(value) || isBoolean(value)) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  const ok = Array.isArray(value)
    ? value.every((item) => isJson(item, seen))
    : (prototype === Object.prototype || prototype === null) &&
      Object.values(value).every((item) => item === undefined || isJson(item, seen));
  seen.delete(value);
  return ok;
}

export function isSpan(value: unknown): value is Span {
  if (typeof value === "string") return true;
  return (
    isRecord(value) &&
    isString(value.text) &&
    optional(value.tone, isTone) &&
    optional(value.bold, isBoolean) &&
    optional(value.icon, (icon) => STATE_ICONS.includes(icon as StateIcon)) &&
    optional(value.since, isFinite) &&
    optional(value.live, (live) => live === true)
  );
}
export function isLine(value: unknown): value is Line {
  return isSpan(value) || (Array.isArray(value) && value.every(isSpan));
}
export function isTitle(value: unknown): value is Title {
  if (typeof value === "string") return true;
  return (
    isRecord(value) &&
    isString(value.label) &&
    optional(value.icon, isString) &&
    optional(value.detail, isString)
  );
}
const isBadgeFace = (value: unknown) =>
  isRecord(value) && isString(value.text) && optional(value.tone, isTone);
export function isBadge(value: unknown): value is Badge {
  return (
    isBadgeFace(value) &&
    optional((value as Record<string, unknown>).live, (live) => live === true || isBadgeFace(live))
  );
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
      optional(value.numbered, (n) => typeof n === "boolean" || isFinite(n))
    );
  return false;
}
/** For content that arrives as data, such as an action's result. */
export function isDetailContent(value: unknown): value is DetailContent {
  return typeof value === "string" || (Array.isArray(value) && value.every(isBlock));
}
/** Has an `action` string. Lenient on purpose: `isActionReference` checks a model's references. */
export function isActionRef(value: unknown): value is ActionRef {
  return isRecord(value) && isString(value.action);
}
/**
 * A reference a model may carry: an action id of the `<extension>.<verb>` shape
 * and JSON arguments; with `objectArgs`, arguments that are a JSON object, since
 * the renderer adds its own fields (`{ id }`, `{ ids }`, an answer) to them.
 */
export function isActionReference(
  value: unknown,
  objectArgs = false,
): value is ActionRef<JsonObject> {
  return (
    isRecord(value) &&
    isString(value.action) &&
    ACTION_ID.test(value.action) &&
    optional(value.args, (args) => isJson(args) && (!objectArgs || isRecord(args)))
  );
}
const isObjectAction = (value: unknown) => isActionReference(value, true);
export function isHint(value: unknown): value is Hint {
  return (
    isRecord(value) &&
    isString(value.keys) &&
    optional(value.action, isString) &&
    optional(value.priority, isFinite)
  );
}

export function isDetailModel(value: unknown): value is DetailModel {
  return isRecord(value) && isTitle(value.title) && isDetailContent(value.content);
}

const isSettledRow = (value: unknown) =>
  isRecord(value) &&
  optional(value.lead, isLine) &&
  optional(value.left, isLine) &&
  optional(value.right, isLines) &&
  optional(value.group, isString);
export function isWidgetRow(value: unknown): value is WidgetRow {
  return (
    isRecord(value) &&
    optional(value.lead, isLine) &&
    isLine(value.left) &&
    optional(value.right, isLines) &&
    optional(value.keepRight, isBoolean) &&
    optional(value.group, isString) &&
    optional(value.live, (live) => live === true || isSettledRow(live))
  );
}
export function isWidgetModel(value: unknown): value is WidgetModel {
  return (
    isRecord(value) &&
    isTitle(value.title) &&
    optional(value.active, isBoolean) &&
    optional(value.meta, isLines) &&
    isArrayOf(value.rows, isWidgetRow) &&
    optional(value.emptyText, isString)
  );
}

function isExplorerItem(value: unknown): value is ExplorerItem {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isLine(value.label) &&
    optional(value.search, isString) &&
    optional(value.badge, isBadge) &&
    optional(value.marked, isBoolean) &&
    optional(value.detail, isDetailContent)
  );
}
const isExplorerTab = (value: unknown) =>
  isRecord(value) &&
  isString(value.label) &&
  isStrings(value.ids) &&
  optional(value.emptyText, isString);
const isExplorerMarker = (value: unknown) =>
  isRecord(value) &&
  isString(value.label) &&
  optional(value.clearAction, isString) &&
  optional(value.onClear, isObjectAction);
export function isExplorerModel(value: unknown): value is ExplorerModel {
  return (
    isRecord(value) &&
    isTitle(value.title) &&
    isArrayOf(value.items, isExplorerItem) &&
    optional(
      value.noun,
      (noun) => Array.isArray(noun) && noun.length === 2 && noun.every(isString),
    ) &&
    optional(value.notices, isLines) &&
    optional(value.tabs, (tabs) => isArrayOf(tabs, isExplorerTab)) &&
    optional(value.initialTab, (tab) => Number.isSafeInteger(tab) && (tab as number) >= 0) &&
    optional(value.marker, isExplorerMarker) &&
    optional(value.emptyText, isString) &&
    optional(value.hints, (hints) => isArrayOf(hints, isHint)) &&
    optional(value.onOpen, isObjectAction) &&
    optional(value.loadDetail, isObjectAction)
  );
}
