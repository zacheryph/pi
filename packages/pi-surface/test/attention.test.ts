import { describe, expect, it } from "vitest";
import { fakeEventBus } from "#test-helpers";
import {
  ATTENTION_VIEW_SUFFIX,
  BB_MESSAGE_BYTES,
  collectDelivery,
  decodeDeliverySnapshot,
  defineView,
  isAttentionModel,
  isAttentionUrl,
  isDeliverySnapshot,
  isViewModel,
  MAX_ATTENTION_ID,
  MAX_ATTENTION_ITEMS,
  MAX_ATTENTION_REASON,
  MAX_ATTENTION_TITLE,
  MAX_ATTENTION_URL,
  readDeliverySnapshot,
  settleSnapshot,
  VIEW_ID,
  VIEW_KINDS,
  type AttentionItem,
  type AttentionModel,
  type DeliveryResult,
  type DeliverySnapshot,
  type ViewKind,
  type WidgetModel,
} from "#src/index";

const SINCE = 1_700_000_000_000;

const review = (id: string, extra: Partial<AttentionItem> = {}): AttentionItem => ({
  id,
  rev: "a13c90e",
  category: "review",
  title: [{ text: "Review ", bold: true }, id],
  reason: "Checkout cleanup · draft at a13c90e",
  state: "ready",
  since: SINCE,
  observedAt: SINCE + 1_000,
  link: { url: "https://github.com/acme/web/pull/42", label: "acme/web#42" },
  open: { action: "git.attention-open", args: { id } },
  dismiss: { action: "git.attention-dismiss", args: { id, rev: "a13c90e" } },
  reply: { action: "git.attention-reply", args: { id, rev: "a13c90e" } },
  ...extra,
});

const attention: AttentionModel = {
  items: [
    review("pr:github.com/acme/web#42"),
    // Raised by a running process, such as a subagent waiting to report.
    review("live:1", { link: undefined, live: true }),
    review("pr:github.com/acme/web#40", { state: "stale", rev: undefined }),
  ],
  total: 5,
};

const widget: WidgetModel = { title: "Tasks", rows: [{ left: "write tests" }] };
const budget = { maxBytes: BB_MESSAGE_BYTES, framingBytes: 64 };

/** A deep copy with one path changed: `set(model, ["a", 0, "b"], value)`. */
function set(value: unknown, path: readonly (string | number)[], next: unknown): unknown {
  const copy = structuredClone(value) as Record<string | number, unknown>;
  let at = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
  at[path.at(-1)!] = next;
  return copy;
}

function ok(result: DeliveryResult) {
  if (!result.ok) throw new Error(`expected a snapshot: ${result.error}`);
  return result;
}

describe("attention model", () => {
  it("accepts owed items, with or without their optional fields", () => {
    expect(isAttentionModel(attention)).toBe(true);
    expect(isViewModel("attention", attention)).toBe(true);
    expect(isAttentionModel({ items: [], total: 0 })).toBe(true);
    const minimal = { id: "x", category: "findings", title: "Read", state: "ready", since: 0 };
    expect(isAttentionModel({ items: [minimal], total: 1 })).toBe(true);
    expect(VIEW_ID.test(`git${ATTENTION_VIEW_SUFFIX}`)).toBe(true);
  });

  it("refuses malformed items", () => {
    const bad: [string, unknown][] = [
      ["no items", { total: 0 }],
      ["total under the items", set(attention, ["total"], 2)],
      ["fractional total", set(attention, ["total"], 3.5)],
      ["duplicate ids", set(attention, ["items", 1, "id"], "pr:github.com/acme/web#42")],
      ["blank id", set(attention, ["items", 0, "id"], " ")],
      ["blank rev", set(attention, ["items", 0, "rev"], "")],
      ["category case", set(attention, ["items", 0, "category"], "Review")],
      ["category spaces", set(attention, ["items", 0, "category"], "to review")],
      ["empty title", set(attention, ["items", 0, "title"], "")],
      ["bad title span", set(attention, ["items", 0, "title"], [{ text: "x", tone: "loud" }])],
      ["state", set(attention, ["items", 0, "state"], "done")],
      ["since NaN", set(attention, ["items", 0, "since"], Number.NaN)],
      ["observedAt string", set(attention, ["items", 0, "observedAt"], "now")],
      ["link without label", set(attention, ["items", 0, "link", "label"], "")],
      ["http link", set(attention, ["items", 0, "link", "url"], "http://github.com/acme")],
      ["script link", set(attention, ["items", 0, "link", "url"], "javascript:alert(1)")],
      ["bad open", set(attention, ["items", 0, "open"], { action: "Open" })],
      ["bad dismiss args", set(attention, ["items", 0, "dismiss", "args"], Number.NaN)],
      ["bad reply", set(attention, ["items", 0, "reply"], { action: "" })],
      ["live false", set(attention, ["items", 0, "live"], false)],
    ];
    for (const [name, value] of bad) expect(isAttentionModel(value), name).toBe(false);
  });

  it("enforces its bounds", () => {
    const many = (count: number) => ({
      items: Array.from({ length: count }, (_, i) => review(`i${i}`)),
      total: count,
    });
    expect(isAttentionModel(many(MAX_ATTENTION_ITEMS))).toBe(true);
    expect(isAttentionModel(many(MAX_ATTENTION_ITEMS + 1))).toBe(false);

    const at = (path: (string | number)[], value: unknown) =>
      isAttentionModel(set(attention, ["items", 0, ...path], value));
    const id = "i".repeat(MAX_ATTENTION_ID);
    expect(at(["id"], id) && at(["rev"], id)).toBe(true);
    expect(at(["id"], `${id}i`) || at(["rev"], `${id}i`)).toBe(false);
    // The title's bound counts every span's text together.
    const half = "t".repeat(MAX_ATTENTION_TITLE / 2);
    expect(at(["title"], [half, { text: half, bold: true }])).toBe(true);
    expect(at(["title"], [half, { text: `${half}t`, bold: true }])).toBe(false);
    const reason = "r".repeat(MAX_ATTENTION_REASON);
    expect(at(["reason"], reason)).toBe(true);
    expect(at(["reason"], `${reason}r`)).toBe(false);
  });

  it("takes only https links a browser can parse, within the bound", () => {
    expect(isAttentionUrl("https://github.com/acme/web/pull/42")).toBe(true);
    expect(isAttentionUrl("HTTPS://GITHUB.COM/acme")).toBe(true);
    const long = `https://example.com/${"p".repeat(MAX_ATTENTION_URL - 20)}`;
    expect(long.length).toBe(MAX_ATTENTION_URL);
    expect(isAttentionUrl(long)).toBe(true);
    expect(isAttentionUrl(`${long}p`)).toBe(false);
    for (const url of ["http://github.com", "file:///etc/passwd", "data:text/html,x", "https:"])
      expect(isAttentionUrl(url), url).toBe(false);
    expect(isAttentionUrl(42)).toBe(false);
  });
});

describe("attention views in a delivery", () => {
  it("round-trip through collectDelivery and the receiver's decoder", () => {
    const bus = fakeEventBus();
    defineView(bus, {
      id: "git.attention",
      kind: "attention",
      title: "Git",
      model: () => attention,
    });
    const result = ok(collectDelivery(bus, { id: "4242", budget }));
    expect(result.snapshot.views).toEqual([
      { id: "git.attention", kind: "attention", title: "Git", model: attention },
    ]);
    expect(isDeliverySnapshot(result.snapshot)).toBe(true);
    expect(decodeDeliverySnapshot(result.json, budget.maxBytes)).toEqual({
      ok: true,
      value: result.snapshot,
    });
  });

  it("send a malformed or over-bound model as an error entry, leaving the other views", () => {
    const bus = fakeEventBus();
    const over = {
      items: Array.from({ length: MAX_ATTENTION_ITEMS + 1 }, (_, i) => review(`i${i}`)),
      total: MAX_ATTENTION_ITEMS + 1,
    };
    defineView(bus, { id: "git.attention", kind: "attention", title: "Git", model: () => over });
    defineView(bus, {
      id: "todo.attention",
      kind: "attention",
      title: "Tasks",
      model: () => set(attention, ["items", 0, "state"], "done") as AttentionModel,
    });
    defineView(bus, { id: "todo.widget", kind: "widget", title: "Tasks", model: () => widget });
    const { snapshot } = ok(collectDelivery(bus, { id: "1", budget }));
    expect(snapshot.views).toEqual([
      {
        id: "git.attention",
        kind: "attention",
        title: "Git",
        error: 'View "git.attention" returned a malformed attention model.',
      },
      {
        id: "todo.attention",
        kind: "attention",
        title: "Tasks",
        error: 'View "todo.attention" returned a malformed attention model.',
      },
      { id: "todo.widget", kind: "widget", title: "Tasks", model: widget },
    ]);

    // A receiver turns a malformed model that reaches it into an error entry too.
    const read = readDeliverySnapshot({
      id: "1",
      views: [{ id: "git.attention", kind: "attention", title: "Git", model: over }],
    });
    expect(read?.views).toEqual([
      { id: "git.attention", kind: "attention", title: "Git", error: "Malformed attention view." },
    ]);
  });

  it("are skipped by a reader that predates the kind, which keeps the other views", () => {
    const sent: DeliverySnapshot = {
      id: "1",
      views: [
        { id: "git.attention", kind: "attention", title: "Git", model: attention },
        { id: "todo.widget", kind: "widget", title: "Tasks", model: widget },
      ],
    };
    // An older copy of the library: the same code without the kind in its list.
    const kinds = VIEW_KINDS as ViewKind[];
    const at = kinds.indexOf("attention");
    kinds.splice(at, 1);
    try {
      expect(readDeliverySnapshot(structuredClone(sent))?.views).toEqual([sent.views[1]]);
      expect(settleSnapshot(sent, SINCE).views).toEqual([sent.views[1]]);
    } finally {
      kinds.splice(at, 0, "attention");
    }
    expect(readDeliverySnapshot(structuredClone(sent))?.views).toEqual(sent.views);
  });
});

describe("settling an attention view", () => {
  const snapshot: DeliverySnapshot = {
    id: "1",
    host: { pid: 7 },
    views: [
      { id: "git.attention", kind: "attention", title: "Git", model: attention },
      { id: "todo.attention", kind: "attention", title: "Tasks", error: "Provider failed." },
    ],
  };

  it("removes live items and every action, and keeps links as last known", () => {
    const before = structuredClone(snapshot);
    const settled = settleSnapshot(snapshot, SINCE + 60_000);
    expect(snapshot).toEqual(before);
    expect(isDeliverySnapshot(settled)).toBe(true);
    const model = settled.views[0]!.model as AttentionModel;
    expect(model.items.map((item) => item.id)).toEqual([
      "pr:github.com/acme/web#42",
      "pr:github.com/acme/web#40",
    ]);
    // The producer's count drops by the items that went with the process.
    expect(model.total).toBe(4);
    for (const item of model.items) {
      expect(item.open, item.id).toBeUndefined();
      expect(item.dismiss, item.id).toBeUndefined();
      expect(item.reply, item.id).toBeUndefined();
      expect(item.link).toEqual(attention.items[0]!.link);
    }
    const { open: _open, dismiss: _dismiss, reply: _reply, ...kept } = attention.items[0]!;
    expect(model.items[0]).toEqual(kept);
    // A failed view is kept as it was, so the consumer still says it failed.
    expect(settled.views[1]).toEqual(snapshot.views[1]);
  });

  it("settles spans in a title, and changes nothing when settled again", () => {
    const clock: AttentionModel = {
      items: [review("x", { title: ["Waiting ", { text: "01:00", since: SINCE, live: true }] })],
      total: 1,
    };
    const settled = settleSnapshot(
      { id: "1", views: [{ id: "git.attention", kind: "attention", title: "Git", model: clock }] },
      SINCE,
    );
    const model = settled.views[0]!.model as AttentionModel;
    expect(model.items[0]!.title).toEqual(["Waiting ", { text: "01:00" }]);
    expect(settleSnapshot(settled, SINCE + 1)).toEqual(settled);
  });

  it("never counts fewer than the items it keeps", () => {
    const capped: AttentionModel = { items: [review("a", { live: true }), review("b")], total: 2 };
    const settled = settleSnapshot(
      { id: "1", views: [{ id: "git.attention", kind: "attention", title: "Git", model: capped }] },
      SINCE,
    );
    expect(settled.views[0]!.model).toMatchObject({ total: 1 });
  });
});
