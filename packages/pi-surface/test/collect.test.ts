import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { fakeEventBus } from "#test-helpers";
import {
  BB_MESSAGE_BYTES,
  collectDelivery,
  collectViews,
  DASHBOARD_LINE_BYTES,
  decodeDeliverySnapshot,
  decodeJson,
  defineView,
  isDeliverySnapshot,
  MAX_VIEW_BYTES,
  MAX_VIEW_ERROR,
  utf8Bytes,
  VIEWS_CHANNEL,
  VIEWS_VERSION,
  type ActionBus,
  type DeliveryResult,
  type FormModel,
  type SessionModel,
  type WidgetModel,
} from "#src/index";

const widget = (rows: number, text = "x"): WidgetModel => ({
  title: "W",
  rows: Array.from({ length: rows }, () => ({ left: text })),
});
const session: SessionModel = {
  sessionId: "s1",
  cwd: "/repo",
  status: { kind: "idle", since: 1 },
  startedAt: 1,
};
const form: FormModel = {
  questionnaires: [
    {
      id: "call-1",
      questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
      submit: { action: "ask.answer", args: { id: "call-1" } },
      cancel: { action: "ask.cancel", args: { id: "call-1" } },
    },
  ],
};
const budget = { maxBytes: BB_MESSAGE_BYTES, framingBytes: 64 };

function ok(result: DeliveryResult) {
  if (!result.ok) throw new Error(`expected a snapshot: ${result.error}`);
  return result;
}

describe("collectViews", () => {
  it("collects every registered view, sorted, leaving out views with nothing to show", () => {
    const bus = fakeEventBus();
    defineView(bus, { id: "todo.widget", kind: "widget", title: "Tasks", model: () => widget(1) });
    defineView(bus, { id: "system.session", kind: "session", title: "S", model: () => session });
    defineView(bus, { id: "ask.questions", kind: "form", title: "Q", model: () => undefined });
    const before = bus.emitted.length;
    const views = collectViews(bus);
    expect(views).toEqual([
      { id: "system.session", kind: "session", title: "S", model: session },
      { id: "todo.widget", kind: "widget", title: "Tasks", model: widget(1) },
    ]);
    // Reading announces nothing: it only asks on the views channel.
    expect(bus.emitted.length).toBeGreaterThan(before);
    expect(bus.emitted.slice(before).every(([channel]) => channel === VIEWS_CHANNEL)).toBe(true);
  });

  it("reads providers at collection time, keeping no copy", () => {
    const bus = fakeEventBus();
    let rows = 1;
    defineView(bus, { id: "todo.widget", kind: "widget", title: "T", model: () => widget(rows) });
    expect(collectViews(bus)[0]!.model).toEqual(widget(1));
    rows = 2;
    expect(collectViews(bus)[0]!.model).toEqual(widget(2));
  });

  it("isolates failing providers: throwing, non-JSON and wrong-kind models become error entries", () => {
    const bus = fakeEventBus();
    defineView(bus, {
      id: "demo.throws",
      kind: "widget",
      title: "Throws",
      model: () => {
        throw new Error("state not loaded");
      },
    });
    defineView(bus, {
      id: "demo.date",
      kind: "detail",
      title: "Date",
      model: () => ({ title: "x", content: "y", at: new Date() }) as never,
    });
    defineView(bus, {
      id: "demo.wrong",
      kind: "summary",
      title: "Wrong",
      model: () => widget(1) as never,
    });
    defineView(bus, {
      id: "demo.long",
      kind: "widget",
      title: "Long",
      model: () => {
        throw new Error("é".repeat(MAX_VIEW_ERROR * 2));
      },
    });
    defineView(bus, {
      id: "demo.blank",
      kind: "widget",
      title: "Blank",
      model: () => {
        throw new Error("   ");
      },
    });
    defineView(bus, { id: "demo.fine", kind: "widget", title: "Fine", model: () => widget(1) });
    const views = collectViews(bus);
    const errors = Object.fromEntries(views.map((view) => [view.id, view.error]));
    expect(errors).toEqual({
      "demo.blank": 'View "demo.blank" failed.',
      "demo.date": 'View "demo.date" returned a model that is not JSON.',
      "demo.fine": undefined,
      "demo.long": "é".repeat(MAX_VIEW_ERROR),
      "demo.throws": "state not loaded",
      "demo.wrong": 'View "demo.wrong" returned a malformed summary model.',
    });
    expect(views.find((view) => view.id === "demo.fine")!.model).toEqual(widget(1));
    expect(isDeliverySnapshot({ id: "1", views })).toBe(true);
  });

  it("works without a system view, and with no views at all", () => {
    const bus = fakeEventBus();
    expect(collectViews(bus)).toEqual([]);
    defineView(bus, { id: "todo.widget", kind: "widget", title: "T", model: () => widget(1) });
    const result = ok(collectDelivery(bus, { id: "4242", budget }));
    expect(result.snapshot.views.map((view) => view.id)).toEqual(["todo.widget"]);
    expect(isDeliverySnapshot(result.snapshot)).toBe(true);
  });

  it("refuses a model over the per-view limit, measured in UTF-8 bytes", () => {
    const bus = fakeEventBus();
    // Under the limit in UTF-16 units, over it in UTF-8 bytes.
    const text = "€".repeat(Math.ceil(MAX_VIEW_BYTES / 3));
    expect(text.length).toBeLessThan(MAX_VIEW_BYTES);
    defineView(bus, { id: "demo.euro", kind: "widget", title: "E", model: () => widget(1, text) });
    defineView(bus, {
      id: "demo.small",
      kind: "widget",
      title: "S",
      model: () => widget(1, "€".repeat(1000)),
    });
    const [euro, small] = collectViews(bus);
    expect(euro).toEqual({
      id: "demo.euro",
      kind: "widget",
      title: "E",
      error: "Too large to send: 257 KB, over 256 KB.",
    });
    expect(small!.model).toBeDefined();
    expect(collectViews(bus, { maxViewBytes: 1000 })[1]!.error).toBe(
      "Too large to send: 3 KB, over 1 KB.",
    );
  });

  it("skips what another library copy lists badly, and throws only when the bus does", () => {
    const bus = fakeEventBus();
    defineView(bus, { id: "todo.widget", kind: "widget", title: "T", model: () => widget(1) });
    bus.on(VIEWS_CHANNEL, (data) => {
      const req = data as { version: number; kind: string; add?: (info: unknown) => void };
      if (req.version !== VIEWS_VERSION || req.kind !== "list") return;
      req.add!({ id: "Bad id", kind: "widget", title: "x" });
      req.add!({ id: "newer.view", kind: "chart", title: "Newer" });
      req.add!({ id: "todo.widget", kind: "widget", title: "Duplicate" });
    });
    expect(collectViews(bus).map((view) => view.title)).toEqual(["T"]);
    const retired: ActionBus = {
      emit: () => {
        throw new Error("ctx is stale");
      },
      on: () => () => {},
    };
    expect(() => collectViews(retired)).toThrow("ctx is stale");
    expect(collectDelivery(retired, { id: "1", budget })).toEqual({
      ok: false,
      error: "Could not read views: ctx is stale",
      bytes: 0,
    });
  });
});

describe("collectDelivery", () => {
  it("builds a strict snapshot whose JSON and byte count are exactly what is sent", () => {
    const bus = createEventBus();
    defineView(bus, { id: "system.session", kind: "session", title: "S", model: () => session });
    defineView(bus, { id: "ask.questions", kind: "form", title: "Q", model: () => form });
    defineView(bus, {
      id: "todo.widget",
      kind: "widget",
      title: "Tâches ✓",
      model: () => widget(2, "naïve 😀"),
    });
    const host = { pid: 42, terminal: { kind: "tmux", label: "%1" } };
    const result = ok(collectDelivery(bus, { id: "4242", host, budget }));
    expect(isDeliverySnapshot(result.snapshot)).toBe(true);
    expect(result.json).toBe(JSON.stringify(result.snapshot));
    expect(result.bytes).toBe(new TextEncoder().encode(result.json).byteLength);
    expect(result.evicted).toEqual([]);
    expect(result.snapshot.host).toEqual(host);
    expect(decodeDeliverySnapshot(result.json, budget.maxBytes)).toEqual({
      ok: true,
      value: result.snapshot,
    });
  });

  it("replaces the largest models with error entries until the envelope fits", () => {
    const bus = fakeEventBus();
    defineView(bus, { id: "demo.a", kind: "widget", title: "A", model: () => widget(400) });
    defineView(bus, { id: "demo.b", kind: "widget", title: "B", model: () => widget(300) });
    defineView(bus, { id: "demo.c", kind: "widget", title: "C", model: () => widget(10) });
    defineView(bus, { id: "ask.questions", kind: "form", title: "Q", model: () => form });
    const full = ok(collectDelivery(bus, { id: "1", budget }));
    // Room for everything but the largest model.
    const maxBytes = full.bytes - 1 + 100;
    const fitted = ok(collectDelivery(bus, { id: "1", budget: { maxBytes, framingBytes: 100 } }));
    expect(fitted.evicted).toEqual(["demo.a"]);
    expect(fitted.bytes).toBeLessThanOrEqual(maxBytes - 100);
    expect(fitted.snapshot.views.find((view) => view.id === "demo.a")!.error).toMatch(
      /^Left out to fit one message: \d+ KB; the update was \d+ KB, over \d+ KB\.$/,
    );
    // The form is untouched while it fits: a model is either whole or replaced, never cut.
    expect(fitted.snapshot.views.find((view) => view.id === "ask.questions")!.model).toEqual(form);
    expect(isDeliverySnapshot(fitted.snapshot)).toBe(true);
    expect(JSON.parse(fitted.json)).toEqual(fitted.snapshot);

    // A tighter budget evicts in size order, the same way every time.
    const tight = { maxBytes: 1200, framingBytes: 0 };
    const first = ok(collectDelivery(bus, { id: "1", budget: tight }));
    expect(first.evicted).toEqual(["demo.a", "demo.b"]);
    expect(first.snapshot.views.map((view) => view.model !== undefined)).toEqual([
      true, // ask.questions
      false,
      false,
      true, // demo.c
    ]);
    expect(collectDelivery(bus, { id: "1", budget: tight })).toEqual(first);
  });

  it("rejects the envelope when even its error entries cannot fit", () => {
    const bus = fakeEventBus();
    defineView(bus, { id: "demo.a", kind: "widget", title: "A", model: () => widget(50) });
    defineView(bus, { id: "demo.b", kind: "widget", title: "B", model: () => widget(50) });
    const result = collectDelivery(bus, { id: "1", budget: { maxBytes: 300, framingBytes: 100 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(
      /^Snapshot does not fit one message: at least 1 KB with every model left out, over 1 KB\.$/,
    );
    expect(result.bytes).toBeGreaterThan(200);
  });

  it("counts multibyte text in the envelope budget", () => {
    const bus = fakeEventBus();
    defineView(bus, {
      id: "demo.a",
      kind: "widget",
      title: "A",
      model: () => widget(1, "😀".repeat(200)),
    });
    const whole = ok(collectDelivery(bus, { id: "1", budget }));
    // Each emoji is 2 UTF-16 units and 4 bytes. A budget of the JSON's length in
    // units would fit it only if bytes were miscounted as units.
    const units = whole.json.length;
    expect(whole.bytes).toBe(units + 400);
    const result = ok(
      collectDelivery(bus, { id: "1", budget: { maxBytes: units, framingBytes: 0 } }),
    );
    expect(result.evicted).toEqual(["demo.a"]);
  });

  it("refuses bad options", () => {
    const bus = fakeEventBus();
    expect(() => collectDelivery(bus, { id: "", budget })).toThrow("Delivery id");
    expect(() => collectDelivery(bus, { id: "x".repeat(129), budget })).toThrow("Delivery id");
    expect(() => collectDelivery(bus, { id: "1", host: { pid: -1 }, budget })).toThrow("HostInfo");
    expect(() =>
      collectDelivery(bus, { id: "1", budget: { maxBytes: 10, framingBytes: 10 } }),
    ).toThrow("no room");
    expect(() =>
      collectDelivery(bus, { id: "1", budget: { maxBytes: 1.5, framingBytes: 0 } }),
    ).toThrow("whole bytes");
  });

  it("names the transports' current ceilings", () => {
    expect(BB_MESSAGE_BYTES).toBe(2 * 1024 * 1024);
    expect(DASHBOARD_LINE_BYTES).toBe(1024 * 1024);
    expect(MAX_VIEW_BYTES).toBe(256 * 1024);
  });
});

describe("receiving side", () => {
  it("counts UTF-8 bytes as TextEncoder does", () => {
    for (const text of ["", "abc", "é", "€", "😀", "a\u{10ffff}b", "\ud800", "x\udc00y", "\ud83d"])
      expect(utf8Bytes(text), JSON.stringify(text)).toBe(new TextEncoder().encode(text).byteLength);
  });

  it("refuses a single oversized complete line before parsing it", () => {
    const line = JSON.stringify({ id: "1", views: [], pad: "x".repeat(2000) });
    expect(decodeJson(line, 1000)).toEqual({
      ok: false,
      error: `Message too large: at least ${line.length} bytes, over 1000.`,
    });
    // Multibyte: under the ceiling in UTF-16 units, over it in bytes.
    const wide = JSON.stringify({ id: "1", views: [], pad: "€".repeat(400) });
    expect(wide.length).toBeLessThan(1000);
    expect(decodeJson(wide, 1000)).toEqual({
      ok: false,
      error: `Message too large: ${utf8Bytes(wide)} bytes, over 1000.`,
    });
    const bytes = new TextEncoder().encode(wide);
    expect(decodeJson(bytes, 1000)).toEqual({
      ok: false,
      error: `Message too large: ${bytes.byteLength} bytes, over 1000.`,
    });
    expect(decodeJson(bytes, bytes.byteLength)).toEqual({ ok: true, value: JSON.parse(wide) });
  });

  it("refuses malformed JSON, invalid UTF-8 and malformed envelopes", () => {
    expect(decodeJson('{"id":', 100)).toEqual({ ok: false, error: "Message is not JSON." });
    expect(decodeJson(new Uint8Array([0x7b, 0xff, 0x7d]), 100)).toEqual({
      ok: false,
      error: "Message is not UTF-8.",
    });
    expect(decodeDeliverySnapshot('{"views":[]}', 100)).toEqual({
      ok: false,
      error: "Malformed snapshot.",
    });
    // A newer producer's kind is tolerated; a malformed known model becomes an error entry.
    const raw = JSON.stringify({
      id: "1",
      views: [
        { id: "new.chart", kind: "chart", title: "C", model: {} },
        { id: "todo.widget", kind: "widget", title: "T", model: { rows: "no" } },
      ],
    });
    expect(decodeDeliverySnapshot(raw, DASHBOARD_LINE_BYTES)).toEqual({
      ok: true,
      value: {
        id: "1",
        views: [{ id: "todo.widget", kind: "widget", title: "T", error: "Malformed widget view." }],
      },
    });
  });
});
