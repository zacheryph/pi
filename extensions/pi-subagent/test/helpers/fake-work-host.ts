import type {
  WorkHost,
  WorkItem,
  WorkItemSpec,
  WorkItemView,
  WorkMessage,
} from "../../../../packages/pi-work/src/index.ts";

/** What happened to one item, in order. */
export type ItemEvent =
  | { kind: "notify"; message: WorkMessage }
  | { kind: "complete"; message: WorkMessage }
  | { kind: "cancel" };

export interface FakeItem {
  id: string;
  spec: WorkItemSpec;
  events: ItemEvent[];
  closed: boolean;
}

/**
 * A work host that records what producers do with their items, and honours the contract's
 * rule that a closed item ignores every later call.
 */
export function fakeWorkHost() {
  const items: FakeItem[] = [];
  const host: WorkHost = {
    open(spec): WorkItem {
      const record: FakeItem = { id: `item${items.length + 1}`, spec, events: [], closed: false };
      items.push(record);
      const view: WorkItemView = { id: record.id, openedAt: 0, ...spec };
      return {
        ...view,
        notify: (message) => {
          if (!record.closed) record.events.push({ kind: "notify", message });
        },
        complete: (message) => {
          if (record.closed) return;
          record.closed = true;
          record.events.push({ kind: "complete", message });
        },
        cancel: () => {
          if (record.closed) return;
          record.closed = true;
          record.events.push({ kind: "cancel" });
        },
      };
    },
    adopt: () => {},
    list: () =>
      items
        .filter((item) => !item.closed)
        .map((item) => ({ id: item.id, openedAt: 0, ...item.spec })),
  };
  return {
    host,
    items,
    /** Every message delivered, in order, whichever item delivered it. */
    messages: () =>
      items.flatMap((item) =>
        item.events.flatMap((event) => (event.kind === "cancel" ? [] : [event.message])),
      ),
  };
}
