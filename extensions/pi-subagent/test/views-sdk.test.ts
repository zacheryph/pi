import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import {
  isViewModel,
  listViews,
  onViewChanged,
  readView,
  type ActionBus,
  type ExplorerModel,
  type SummaryModel,
  type WidgetModel,
} from "#surface";
import {
  SUBAGENT_EXPLORER_VIEW,
  SUBAGENT_SUMMARY_VIEW,
  SUBAGENT_WIDGET_VIEW,
} from "#src/observation/snapshot";
import { delegate, gated, startParent, untilAnnounced } from "#test/characterization/harness";

const counts = (model: SummaryModel) =>
  Object.fromEntries(model.counts.map((count) => [count.key, count.value]));

it("offers the widget, the branch's subagents and their counts as views, announced as agents change", async () => {
  let bus: ActionBus | undefined;
  const changed: string[] = [];
  const h = await startParent({
    extensions: [
      (pi) => {
        bus = pi.events;
        onViewChanged(pi.events, (id) => changed.push(id));
      },
    ],
  });
  expect(listViews(bus!)).toEqual([
    { id: SUBAGENT_EXPLORER_VIEW, kind: "explorer", title: "Subagents" },
    { id: SUBAGENT_SUMMARY_VIEW, kind: "summary", title: "Subagents" },
    { id: SUBAGENT_WIDGET_VIEW, kind: "widget", title: "Subagents" },
  ]);
  expect(readView(bus!, SUBAGENT_WIDGET_VIEW)).toBeUndefined();
  expect((readView(bus!, SUBAGENT_EXPLORER_VIEW) as ExplorerModel).items).toEqual([]);
  // No subagent yet: the summary reads zeros, and no main-agent profile runs.
  const empty = readView(bus!, SUBAGENT_SUMMARY_VIEW) as SummaryModel;
  expect(isViewModel("summary", empty)).toBe(true);
  expect(counts(empty)).toEqual({
    running: 0,
    queued: 0,
    waiting: 0,
    completed: 0,
    failed: 0,
    stopped: 0,
    total: 0,
  });
  expect(empty.profile).toBeUndefined();

  const child = gated(fauxAssistantMessage("Finished."));
  h.script({
    parent: [delegate("Work"), fauxAssistantMessage("Started."), fauxAssistantMessage("Noted.")],
    child: [child.step],
  });
  changed.length = 0;
  await h.session.prompt("Delegate work");
  await child.started;
  const [id] = h.agentIds();
  expect(changed).toEqual(
    expect.arrayContaining([SUBAGENT_WIDGET_VIEW, SUBAGENT_EXPLORER_VIEW, SUBAGENT_SUMMARY_VIEW]),
  );
  const running = readView(bus!, SUBAGENT_WIDGET_VIEW) as WidgetModel;
  expect(isViewModel("widget", running)).toBe(true);
  expect(running.active).toBe(true);
  expect(running.rows).toHaveLength(1);
  expect((readView(bus!, SUBAGENT_EXPLORER_VIEW) as ExplorerModel).items).toMatchObject([
    { id, badge: { text: "running" } },
  ]);
  expect(counts(readView(bus!, SUBAGENT_SUMMARY_VIEW) as SummaryModel)).toMatchObject({
    running: 1,
    total: 1,
  });

  child.release();
  await untilAnnounced(h);
  await h.session.waitForIdle();
  expect((readView(bus!, SUBAGENT_EXPLORER_VIEW) as ExplorerModel).items).toMatchObject([
    { id, badge: { text: "done" } },
  ]);
  expect(counts(readView(bus!, SUBAGENT_SUMMARY_VIEW) as SummaryModel)).toMatchObject({
    running: 0,
    completed: 1,
    total: 1,
  });

  // A reload defines them again on the same bus, once, with the finished history restored.
  await h.session.reload();
  expect(listViews(bus!).map((view) => view.id)).toEqual([
    SUBAGENT_EXPLORER_VIEW,
    SUBAGENT_SUMMARY_VIEW,
    SUBAGENT_WIDGET_VIEW,
  ]);
  // The widget has no row left to show; the summary still counts the branch's history.
  expect(readView(bus!, SUBAGENT_WIDGET_VIEW)).toBeUndefined();
  expect(counts(readView(bus!, SUBAGENT_SUMMARY_VIEW) as SummaryModel)).toMatchObject({
    completed: 1,
    total: 1,
  });
}, 30_000);

it("announces live tool activity before a child finishes or the parent prompts again", async () => {
  const announcedWidgets: string[] = [];
  let bus: ActionBus | undefined;
  const h = await startParent({
    extensions: [
      (pi) => {
        bus = pi.events;
        onViewChanged(pi.events, (id) => {
          if (id === SUBAGENT_WIDGET_VIEW) {
            announcedWidgets.push(JSON.stringify(readView(pi.events, id)) ?? "");
          }
        });
      },
    ],
  });
  const finish = gated(fauxAssistantMessage("Read complete."));
  h.script({
    parent: [
      delegate("Read a file"),
      fauxAssistantMessage("Started."),
      fauxAssistantMessage("Noted."),
    ],
    child: [
      fauxAssistantMessage([fauxToolCall("read", { path: join(h.dir, "settings.json") })]),
      finish.step,
    ],
  });

  try {
    await h.session.prompt("Delegate a read");
    await finish.started;
    expect(h.announcements()).toHaveLength(0);
    expect(h.requests.parent).toHaveLength(2);
    // Read at announcement time, just as remote consumers do. Merely reading a
    // live model here would conceal the bug: it is fresh even without a notification.
    expect(announcedWidgets.some((model) => model.includes("reading…"))).toBe(true);
    expect(JSON.stringify(readView(bus!, SUBAGENT_WIDGET_VIEW))).toContain("thinking…");
    const [id] = h.agentIds();
    expect(h.savedRecord(id!)?.toolUses).toBe(0); // activity did not persist lifecycle records
  } finally {
    finish.release();
  }
  await untilAnnounced(h);
  await h.session.waitForIdle();
  expect(h.savedRecord(h.agentIds()[0]!)?.toolUses).toBe(1);
}, 30_000);
