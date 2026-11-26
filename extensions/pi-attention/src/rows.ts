import { plural } from "#foundations/format";
import {
  attentionRows,
  collectViews,
  listViews,
  type ActionBus,
  type AttentionList,
  type AttentionRow,
} from "#surface";
import { plainText, sanitizeLine } from "#ui";

// What this session owes the user, read from its own bus. Only `attention`
// views count: an open questionnaire or a waiting status is already on screen
// as pi-ask's window (Blocking, in the roadmap's words), so the terminal shows
// Owed rows alone. The dashboard and bb, which look at sessions from outside,
// show both.

export const EMPTY: AttentionList = { rows: [], blocking: 0, owed: 0, more: 0, failed: [] };

/** The overlay's title, and the first line of the printed list. */
export const LIST_TITLE = "Needs you · this session";
/** What `/attention` says when nothing is owed. */
export const EMPTY_TEXT = "Nothing needs you in this session.";
/** The diamond the hint and the list draw: filled for ready, hollow for stale. */
export const READY_ICON = "◆";
export const STALE_ICON = "◇";

export type Attention = {
  list: AttentionList;
  /** Ids of the attention views on the bus when it was read, failed ones included. */
  views: ReadonlySet<string>;
};

/** Ids of the views of kind `attention` on `bus`: one list request, no model is read. */
export function attentionViews(bus: ActionBus): Set<string> {
  return new Set(
    listViews(bus)
      .filter((view) => view.kind === "attention")
      .map((view) => view.id),
  );
}

/**
 * Read every attention view on `bus` and derive its rows with `attentionRows`.
 * Collects nothing when no view is of kind `attention`, so a session without a
 * producer pays one list request. Throws only when the bus does.
 */
export function readAttention(bus: ActionBus): Attention {
  const ids = attentionViews(bus);
  if (!ids.size) return { list: EMPTY, views: ids };
  const views = collectViews(bus).filter((entry) => entry.kind === "attention");
  return { list: attentionRows({ views }), views: ids };
}

/** `◆ 2 need you · /attention`, or `undefined` while nothing is owed. */
export function hintText(list: AttentionList): string | undefined {
  if (list.owed <= 0) return undefined;
  return `${READY_ICON} ${list.owed} ${plural(list.owed, "needs", "need")} you · /attention`;
}

/** `12m`, `3h`, `2d`: how long a row has been owed, or `undefined` without a time. */
export function age(since: number | undefined, now: number): string | undefined {
  if (since === undefined || !Number.isFinite(since)) return undefined;
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The badge a row shows: `Ready` or `Stale`. */
export function stateLabel(row: AttentionRow): string {
  return row.state === "stale" ? "Stale" : "Ready";
}

/** The second line of a row: its reason and age, joined by ` · `. */
export function detailText(row: AttentionRow, now: number): string {
  return [row.reason && sanitizeLine(row.reason), age(row.since, now)].filter(Boolean).join(" · ");
}

/** A note for views whose model could not be read, or `undefined`. */
export function failedText(list: AttentionList): string | undefined {
  return list.failed.length ? `Couldn't read ${list.failed.join(", ")}.` : undefined;
}

/** Owed items the producers count but did not list. */
export function moreText(list: AttentionList): string | undefined {
  return list.more > 0 ? `and ${list.more} more` : undefined;
}

/**
 * The list as plain text, for `/attention` outside the terminal: one block per
 * row (title and state, its reason and age, its link), then what is left out.
 */
export function describe(list: AttentionList, now: number): string {
  const notes = [failedText(list), moreText(list)].filter((note) => note !== undefined);
  if (!list.rows.length) return [EMPTY_TEXT, ...notes].join("\n");
  const lines = [LIST_TITLE];
  for (const row of list.rows) {
    const icon = row.state === "stale" ? STALE_ICON : READY_ICON;
    lines.push(`${icon} ${plainText(row.title)} · ${stateLabel(row)}`);
    const detail = detailText(row, now);
    if (detail) lines.push(`  ${detail}`);
    if (row.link) lines.push(`  ${sanitizeLine(row.link.url)}`);
  }
  return [...lines, ...notes].join("\n");
}
