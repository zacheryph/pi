import { describe, expect, it } from "vitest";
import {
  isDeliverySnapshot,
  settleSnapshot,
  settleViews,
  type DeliverySnapshot,
  type ExplorerModel,
  type SessionModel,
  type SummaryModel,
  type ViewEntry,
  type WidgetModel,
} from "#src/index";
import { SAVED_AT, staleRunningCard } from "#test/fixtures/stale-running-card";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Every object and array inside `value`, itself included. */
function objects(value: unknown, found = new Set<object>()): Set<object> {
  if (typeof value === "object" && value !== null && !found.has(value)) {
    found.add(value);
    for (const item of Object.values(value)) objects(item, found);
  }
  return found;
}

/** Every `{ ... }` object inside `value` that has `key`. */
function withKey(value: unknown, key: string): object[] {
  return [...objects(value)].filter((item) => !Array.isArray(item) && key in item);
}

const model = <T>(snapshot: DeliverySnapshot, id: string) =>
  snapshot.views.find((view) => view.id === id)?.model as T;

const SETTLED_AT = SAVED_AT + 60_000;

describe("settleSnapshot: the stale-running bb card", () => {
  const saved = deepFreeze(structuredClone(staleRunningCard) as DeliverySnapshot);
  const before = structuredClone(saved);
  const settled = settleSnapshot(saved, SETTLED_AT);

  it("starts from a strict snapshot showing running agents", () => {
    expect(isDeliverySnapshot(saved)).toBe(true);
    expect(withKey(saved, "since").length).toBeGreaterThan(0);
    expect(withKey(saved, "live").length).toBeGreaterThan(0);
  });

  it("leaves no running clock and no live mark anywhere", () => {
    expect(isDeliverySnapshot(settled)).toBe(true);
    expect(withKey(settled, "live")).toEqual([]);
    // The status's and activity's own timestamps are history; no span keeps a clock.
    const spans = withKey(settled, "text");
    expect(spans.filter((span) => "since" in span)).toEqual([]);
  });

  it("stops the running agents' rows and heading, and keeps finished history", () => {
    const widget = model<WidgetModel>(settled, "subagent.widget");
    expect(widget.active).toBe(false);
    expect(widget.meta).toEqual([]);
    const [running, waiting, finished] = widget.rows;
    expect(running).toEqual({
      lead: { text: "02:13", tone: "dim" },
      left: [{ text: "Explore", bold: true }, ": ", { text: "map the views", tone: "muted" }],
      right: [
        [
          { text: "■", tone: "dim", icon: "stopped" },
          { text: " stopped", tone: "dim" },
        ],
      ],
      group: "stopped",
    });
    expect(waiting!.group).toBe("stopped");
    expect(JSON.stringify(waiting)).not.toContain("waiting");
    // Not live: the finished agent is history and stays as it was.
    expect(finished).toEqual(model<WidgetModel>(saved, "subagent.widget").rows[2]);
    expect(JSON.stringify(widget.rows).match(/"icon":"\w+"/g)).toEqual([
      '"icon":"stopped"',
      '"icon":"stopped"',
      '"icon":"done"',
    ]);
  });

  it("settles live badges and counts, and drops a live active item", () => {
    const explorer = model<ExplorerModel>(settled, "subagent.explorer");
    expect(explorer.items.map((item) => item.badge)).toEqual([
      { text: "stopped", tone: "dim" },
      undefined,
      { text: "done", tone: "success" },
    ]);
    const summary = model<SummaryModel>(settled, "subagent.summary");
    expect(summary.counts.map(({ key, value }) => [key, value])).toEqual([
      ["running", 0],
      ["waiting", 0],
      ["queued", 0],
      ["completed", 1],
    ]);
    expect(summary.active).toBeUndefined();
    expect(summary.profile).toEqual({ name: "default", label: "Default agent" });
  });

  it("keeps persisted task states, though they share the active icon", () => {
    expect(model(settled, "todo.widget")).toEqual(model(saved, "todo.widget"));
    expect(model(settled, "todo.summary")).toEqual(model(saved, "todo.summary"));
    const tasks = model<ExplorerModel>(settled, "todo.explorer");
    expect(tasks.items).toEqual(model<ExplorerModel>(saved, "todo.explorer").items);
  });

  it("idles the session and its running tool call, keeping finished calls and totals", () => {
    const session = model<SessionModel>(settled, "system.session");
    const original = model<SessionModel>(saved, "system.session");
    expect(session.status).toEqual({ kind: "idle", since: SETTLED_AT });
    expect(session.activity).toEqual([
      { tool: "subagent", summary: "Explore", at: original.activity![0]!.at },
      original.activity![1],
    ]);
    expect(session.usage).toEqual(original.usage);
    expect(session.startedAt).toBe(original.startedAt);
  });

  it("removes forms, the host and every action reference; included details still open", () => {
    expect(settled.views.map((view) => view.id)).toEqual([
      "git.widget",
      "subagent.explorer",
      "subagent.summary",
      "subagent.widget",
      "system.session",
      "todo.explorer",
      "todo.summary",
      "todo.widget",
    ]);
    expect(settled.host).toBeUndefined();
    expect(withKey(settled, "action")).toEqual([]);
    expect(settled.views[0]).toEqual(saved.views[1]);
    const tasks = model<ExplorerModel>(settled, "todo.explorer");
    expect(tasks.marker).toEqual({ label: "unreviewed" });
    expect(tasks.loadDetail).toBeUndefined();
    expect(tasks.onOpen).toBeUndefined();
    const agents = model<ExplorerModel>(settled, "subagent.explorer");
    expect(agents.items[0]!.detail).toEqual(
      model<ExplorerModel>(saved, "subagent.explorer").items[0]!.detail,
    );
    expect(agents.tabs).toEqual(model<ExplorerModel>(saved, "subagent.explorer").tabs);
  });

  it("never changes its input and shares nothing with it", () => {
    expect(saved).toEqual(before);
    const inputs = objects(saved);
    expect([...objects(settled)].filter((item) => inputs.has(item))).toEqual([]);
  });

  it("is idempotent", () => {
    expect(settleSnapshot(settled, SETTLED_AT + 1)).toEqual(settled);
  });
});

describe("settleViews", () => {
  it("keeps an idle status's own time and settles a live span with no icon", () => {
    const views = deepFreeze([
      {
        id: "system.session",
        kind: "session",
        title: "S",
        model: { sessionId: "s", cwd: "/", status: { kind: "idle", since: 5 }, startedAt: 1 },
      },
      {
        id: "demo.detail",
        kind: "detail",
        title: "D",
        model: {
          title: "D",
          content: [{ fields: [["Elapsed", { text: "00:09", since: 1, live: true }]] }],
        },
      },
      { id: "ask.questions", kind: "form", title: "Q", error: "Too large to send." },
    ] satisfies ViewEntry[]);
    expect(settleViews(views, 99)).toEqual([
      views[0],
      {
        id: "demo.detail",
        kind: "detail",
        title: "D",
        model: { title: "D", content: [{ fields: [["Elapsed", { text: "00:09" }]] }] },
      },
    ]);
  });

  it("applies `true` marks: a badge is removed, a row and a heading keep their fields", () => {
    const views = settleViews(
      [
        {
          id: "demo.widget",
          kind: "widget",
          title: "W",
          model: {
            title: "W",
            active: true,
            live: true,
            rows: [{ left: { text: "x", icon: "active", live: true }, live: true }],
          },
        },
        {
          id: "demo.explorer",
          kind: "explorer",
          title: "E",
          model: {
            title: "E",
            items: [{ id: "a", label: "a", badge: { text: "on", live: true } }],
          },
        },
      ],
      1,
    );
    expect(views[0]!.model).toEqual({
      title: "W",
      active: true,
      rows: [{ left: { text: "x", icon: "stopped" } }],
    });
    expect(views[1]!.model).toEqual({ title: "E", items: [{ id: "a", label: "a" }] });
  });

  it("drops entries of kinds this copy does not know", () => {
    const newer = { id: "new.chart", kind: "chart", title: "C", model: {} } as unknown as ViewEntry;
    expect(settleViews([newer], 1)).toEqual([]);
  });
});
