// One list of what needs the user in a session, shared by every consumer so bb's
// Attention page, its context card and the dashboard show the same rows in the
// same order.
//
// `attentionRows` is self-contained: it uses no module-level value and no
// import at run time, so a renderer that cannot import modules (the dashboard
// page's inline script) can embed its source with `Function.prototype.toString`
// and get the same rows.

import type { AttentionLink } from "#src/attention";
import type { DeliverySnapshot } from "#src/delivery";
import type { ActionRef, Line } from "#src/model";

/**
 * One thing that needs the user. **Blocking** rows hold the session up: an
 * open questionnaire, or a session waiting on a dialog with no questionnaire.
 * **Owed** rows come from attention views: the session goes on without them.
 */
export type AttentionRow = {
  /** Unique within the session: `<viewId>/<itemId>`. Across sessions, prefix the session's id. */
  key: string;
  kind: "blocking" | "owed";
  /** The view the row came from, e.g. `ask.questions`, `system.session`, `git.attention`. */
  viewId: string;
  /** The questionnaire's id, `waiting` for a waiting session, or the attention item's id. */
  itemId: string;
  /** `question` for a questionnaire, `waiting` for a waiting session, else the item's category. */
  category: string;
  title: Line;
  reason?: string;
  /** Blocking rows are always ready. */
  state: "ready" | "stale";
  /** Since when it has needed the user, epoch milliseconds, when known. */
  since?: number;
  /** An attention item's revision. */
  rev?: string;
  /** An attention item's link, only when it is `https:`. */
  link?: AttentionLink;
  open?: ActionRef;
  dismiss?: ActionRef;
  /** Answers the item: dispatched with its arguments plus `{ text }`. */
  reply?: ActionRef;
};

export type AttentionList = {
  /** Blocking rows, then ready owed rows, then stale ones; oldest first within each. */
  rows: AttentionRow[];
  /** How many rows are blocking. */
  blocking: number;
  /** Owed items the producers count, rows and `more` together. */
  owed: number;
  /** Owed items the producers count beyond the ones their views list. */
  more: number;
  /** Form and attention views whose model failed, by id: what they hold is unknown. */
  failed: string[];
};

/**
 * Everything in one session's views that needs the user, as rows. Pass views
 * a receiver has already read (`readDeliverySnapshot`) or settled
 * (`settleSnapshot`): a settled snapshot has no forms and no waiting status,
 * so only owed rows remain. Links are checked again and dropped unless they
 * are `https:`.
 */
export function attentionRows(snapshot: Pick<DeliverySnapshot, "views">): AttentionList {
  const httpsLink = (link: AttentionLink | undefined) => {
    if (!link || typeof link.url !== "string") return undefined;
    try {
      return new URL(link.url).protocol === "https:" ? link : undefined;
    } catch {
      return undefined;
    }
  };
  const blocking: AttentionRow[] = [];
  const owed: AttentionRow[] = [];
  const failed: string[] = [];
  let total = 0;
  let waiting: AttentionRow | undefined;
  for (const entry of snapshot.views) {
    if (entry.kind !== "form" && entry.kind !== "attention" && entry.kind !== "session") continue;
    if (!entry.model) {
      if (entry.kind !== "session") failed.push(entry.id);
      continue;
    }
    if (entry.kind === "session") {
      const status = entry.model.status;
      if (!waiting && status.kind === "waiting")
        waiting = {
          key: `${entry.id}/waiting`,
          kind: "blocking",
          viewId: entry.id,
          itemId: "waiting",
          category: "waiting",
          title: status.title || "Waiting for you",
          state: "ready",
          since: status.since,
        };
    } else if (entry.kind === "form") {
      for (const questionnaire of entry.model.questionnaires) {
        const questions = questionnaire.questions;
        const count = questions.length > 1 ? `${questions.length} questions` : undefined;
        const first = questions[0]?.question ?? "";
        const row: AttentionRow = {
          key: `${entry.id}/${questionnaire.id}`,
          kind: "blocking",
          viewId: entry.id,
          itemId: questionnaire.id,
          category: "question",
          title: questionnaire.title || first,
          state: "ready",
        };
        const reason = questionnaire.title ? (count ?? first) : count;
        if (reason) row.reason = reason;
        if (questionnaire.openedAt !== undefined) row.since = questionnaire.openedAt;
        blocking.push(row);
      }
    } else {
      total += Math.max(entry.model.total, entry.model.items.length);
      for (const item of entry.model.items) {
        const row: AttentionRow = {
          key: `${entry.id}/${item.id}`,
          kind: "owed",
          viewId: entry.id,
          itemId: item.id,
          category: item.category,
          title: item.title,
          state: item.state === "stale" ? "stale" : "ready",
          since: item.since,
        };
        const link = httpsLink(item.link);
        if (item.reason) row.reason = item.reason;
        if (item.rev !== undefined) row.rev = item.rev;
        if (link) row.link = { url: link.url, label: link.label };
        if (item.open) row.open = item.open;
        if (item.dismiss) row.dismiss = item.dismiss;
        if (item.reply) row.reply = item.reply;
        owed.push(row);
      }
    }
  }
  // A questionnaire says what the session waits on; the bare status is only for other dialogs.
  if (waiting && blocking.length === 0) blocking.push(waiting);
  const rank = (row: AttentionRow) => (row.kind === "blocking" ? 0 : row.state === "ready" ? 1 : 2);
  const rows = [...blocking, ...owed].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.since ?? Infinity) - (b.since ?? Infinity) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return {
    rows,
    blocking: blocking.length,
    owed: total,
    more: total - owed.length,
    failed,
  };
}
