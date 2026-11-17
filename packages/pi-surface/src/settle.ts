import type { DeliverySnapshot, ViewEntry } from "#src/delivery";
import type {
  Badge,
  Block,
  DetailContent,
  ExplorerItem,
  ExplorerModel,
  Line,
  Span,
  WidgetModel,
  WidgetRow,
} from "#src/model";
import type { SessionModel } from "#src/session";
import type { SummaryModel } from "#src/summary";
import { isViewKind } from "#src/views";

// Saved-state normalization: a snapshot as it should be shown once the Pi
// process that produced it has gone, e.g. a thread bb restores from its saved
// record. Every rule acts on an explicit `live` mark (see `#src/model`), never
// on an icon, tone or text, so persisted state survives unchanged.

function settleSpan(span: Span): Span {
  if (typeof span === "string" || !span.live) return span;
  const { since: _since, live: _live, ...rest } = span;
  return rest.icon ? { ...rest, icon: "stopped" } : rest;
}

function settleLine(line: Line): Line {
  return Array.isArray(line) ? (line as readonly Span[]).map(settleSpan) : settleSpan(line as Span);
}

const settleLines = (lines: readonly Line[]) => lines.map(settleLine);

function settleBadge(badge: Badge): Badge | undefined {
  if (!badge.live) return badge;
  return badge.live === true ? undefined : { ...badge.live };
}

function settleRow(row: WidgetRow): WidgetRow {
  const { live, ...own } = row;
  const merged: WidgetRow = live && live !== true ? { ...own, ...live } : own;
  const { lead, right } = merged;
  return {
    ...merged,
    ...(lead !== undefined ? { lead: settleLine(lead) } : {}),
    left: settleLine(merged.left),
    ...(right ? { right: settleLines(right) } : {}),
  };
}

function settleWidget(model: WidgetModel): WidgetModel {
  const { live, ...own } = model;
  const merged: WidgetModel = live && live !== true ? { ...own, ...live } : own;
  return {
    ...merged,
    ...(merged.meta ? { meta: settleLines(merged.meta) } : {}),
    rows: merged.rows.map(settleRow),
  };
}

function settleBlock(block: Block): Block {
  return "fields" in block
    ? { fields: block.fields.map(([label, value]) => [label, settleLine(value)] as const) }
    : block;
}

function settleContent(content: DetailContent): DetailContent {
  return typeof content === "string" ? content : content.map(settleBlock);
}

function settleItem(item: ExplorerItem): ExplorerItem {
  const { badge, detail, ...rest } = item;
  const settled = badge && settleBadge(badge);
  return {
    ...rest,
    label: settleLine(item.label),
    ...(settled ? { badge: settled } : {}),
    ...(detail !== undefined ? { detail: settleContent(detail) } : {}),
  };
}

function settleExplorer(model: ExplorerModel): ExplorerModel {
  // No session runs the explorer's actions: an item opens into its included detail only.
  const { onOpen: _onOpen, loadDetail: _loadDetail, marker, notices, ...rest } = model;
  const { onClear: _onClear, clearAction: _clearAction, ...keptMarker } = marker ?? { label: "" };
  return {
    ...rest,
    items: model.items.map(settleItem),
    ...(notices ? { notices: settleLines(notices) } : {}),
    ...(marker ? { marker: keptMarker } : {}),
  };
}

function settleSession(model: SessionModel, settledAt: number): SessionModel {
  const { activity, status } = model;
  return {
    ...model,
    status: status.kind === "idle" ? status : { kind: "idle", since: settledAt },
    ...(activity
      ? {
          activity: activity.map((call) => {
            if (!call.live) return call;
            const { live: _live, durationMs: _durationMs, ...rest } = call;
            return rest;
          }),
        }
      : {}),
  };
}

function settleSummary(model: SummaryModel): SummaryModel {
  const { active, ...rest } = model;
  return {
    ...rest,
    counts: model.counts.map((count) => {
      if (!count.live) return count;
      const { live: _live, ...settled } = count;
      return { ...settled, value: 0 };
    }),
    ...(active && !active.live ? { active } : {}),
  };
}

function settleEntry(entry: ViewEntry, settledAt: number): ViewEntry | undefined {
  // Nobody can answer a form once its process has gone; an unknown kind cannot be settled.
  if (entry.kind === "form" || !isViewKind(entry.kind)) return undefined;
  if (entry.model === undefined) return entry;
  switch (entry.kind) {
    case "widget":
      return { ...entry, model: settleWidget(entry.model) };
    case "explorer":
      return { ...entry, model: settleExplorer(entry.model) };
    case "detail":
      return { ...entry, model: { ...entry.model, content: settleContent(entry.model.content) } };
    case "session":
      return { ...entry, model: settleSession(entry.model, settledAt) };
    case "summary":
      return { ...entry, model: settleSummary(entry.model) };
  }
}

/**
 * Collected views as they should be shown with no live session, as a new
 * copy: the input, possibly a live producer's own objects, is never changed
 * and shares nothing with the result.
 *
 * - Form views are removed, error entries included: nobody can answer them.
 * - Every `live` mark settles as its type documents, and the mark is dropped:
 *   a span loses its clock and an icon reads `stopped`; a badge is replaced or
 *   removed; a widget row or heading takes its settled fields; a summary count
 *   reads 0; a live active item is removed; a running activity call loses its
 *   flag and duration; a session status other than idle becomes
 *   `{ kind: "idle", since: settledAt }`, and an idle status keeps its `since`.
 * - Unmarked state, such as a task's `active` icon or finished history, is
 *   kept as it is.
 * - Actions are disabled by removing their references: an explorer's
 *   `onOpen` and `loadDetail`, and its marker's `onClear` with the
 *   `clearAction` hint. An item with included `detail` still opens into it.
 * - An entry of a kind this copy does not know is removed.
 *
 * `settledAt` is when the session stopped being live, in epoch milliseconds,
 * such as when its last snapshot was saved or its connection closed.
 */
export function settleViews(views: readonly ViewEntry[], settledAt: number): ViewEntry[] {
  return structuredClone(views).flatMap((entry) => settleEntry(entry, settledAt) ?? []);
}

/**
 * A delivery snapshot as it should be shown with no live session: its views
 * settled as `settleViews` does, and without `host`, which describes the
 * process that has gone (its pid, and the terminal Focus would bring forward).
 */
export function settleSnapshot(snapshot: DeliverySnapshot, settledAt: number): DeliverySnapshot {
  return { id: snapshot.id, views: settleViews(snapshot.views, settledAt) };
}
