import {
  actionRegistry,
  viewRegistry,
  type ActionBus,
  type AttentionItem,
  type AttentionList,
  type AttentionModel,
  type AttentionRow,
} from "#surface";

/** A fixed clock: rows are dated relative to it. */
export const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

/** The mockup's three items, as two producers would publish them. */
export function reviewItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "pr:github.com/acme/web#42",
    rev: "a13c90e",
    category: "review",
    title: "Review acme/web#42",
    reason: "Checkout cleanup · draft at a13c90e",
    state: "ready",
    since: NOW - 12 * MINUTE,
    link: { url: "https://github.com/acme/web/pull/42", label: "acme/web#42" },
    dismiss: { action: "git.attention-dismiss", args: { id: "pr:github.com/acme/web#42" } },
    ...overrides,
  };
}

export const staleItem: AttentionItem = {
  id: "pr:github.com/acme/api#57",
  category: "review",
  title: "acme/api#57",
  reason: "Pushed since you were asked",
  state: "stale",
  since: NOW - 3 * 60 * MINUTE,
  link: { url: "https://github.com/acme/api/pull/57", label: "acme/api#57" },
};

export const findingsItem: AttentionItem = {
  id: "task:fix-auth-bug",
  category: "findings",
  title: "2 findings to discuss",
  reason: "fix-auth-bug · retry-backoff",
  state: "ready",
  since: NOW - 5 * MINUTE,
  open: { action: "todo.attention-open", args: { id: "fix-auth-bug" } },
};

/**
 * Fixture producers on a fake session bus: a `git.attention` and a
 * `todo.attention` view whose models the test changes, with their actions.
 */
export function producers(bus: ActionBus) {
  const views = viewRegistry(bus);
  const actions = actionRegistry(bus);
  const state: { git?: AttentionModel; todo?: AttentionModel } = {
    git: { items: [reviewItem(), staleItem], total: 2 },
    todo: { items: [findingsItem], total: 1 },
  };
  const dismissed: unknown[] = [];
  const opened: unknown[] = [];
  views.define({ id: "git.attention", kind: "attention", title: "Git", model: () => state.git });
  views.define({ id: "todo.attention", kind: "attention", title: "Todo", model: () => state.todo });
  actions.define({
    id: "git.attention-dismiss",
    title: "Dismiss",
    handler: (args) => {
      dismissed.push(args);
      const id = (args as { id: string }).id;
      state.git = state.git && {
        items: state.git.items.filter((item) => item.id !== id),
        total: state.git.total - 1,
      };
      views.changed("git.attention");
    },
  });
  actions.define({
    id: "todo.attention-open",
    title: "Open",
    handler: (args) => void opened.push(args),
  });
  return {
    state,
    dismissed,
    opened,
    views,
    actions,
    /** Replace one producer's model and announce it, as a producer does. */
    set(id: "git" | "todo", model: AttentionModel | undefined) {
      state[id] = model;
      views.changed(`${id}.attention`);
    },
  };
}

/** A row as `attentionRows` makes it, for rendering tests that need no bus. */
export function row(item: AttentionItem, viewId = "git.attention"): AttentionRow {
  return {
    key: `${viewId}/${item.id}`,
    kind: "owed",
    viewId,
    itemId: item.id,
    category: item.category,
    title: item.title,
    ...(item.reason ? { reason: item.reason } : {}),
    state: item.state,
    since: item.since,
    ...(item.link ? { link: item.link } : {}),
    ...(item.open ? { open: item.open } : {}),
    ...(item.dismiss ? { dismiss: item.dismiss } : {}),
  };
}

export function listOf(rows: AttentionRow[], extra: Partial<AttentionList> = {}): AttentionList {
  return { rows, blocking: 0, owed: rows.length, more: 0, failed: [], ...extra };
}
