import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import todoExtension from "#todo";
import {
  collectViews,
  isViewModel,
  onViewChanged,
  readView,
  settleViews,
  type ActionBus,
  type ExplorerModel,
  type SummaryModel,
  type ViewEntry,
  type WidgetModel,
} from "#surface";
import { MAIN_AGENT_ENTRY } from "#src/main-agent-profile";
import { SUBAGENT_SUMMARY_VIEW } from "#src/observation/snapshot";
import { delegate, gated, startParent, untilAnnounced } from "#test/characterization/harness";
import { offlineAgentDir, TODO_TOOLS } from "#test/helpers/sdk";
import { toolCall } from "#test-helpers";

const counts = (model: SummaryModel) =>
  Object.fromEntries(model.counts.map((count) => [count.key, count.value]));

it("carries the main agent's profile with no subagents, and follows it across /tree", async () => {
  const dir = offlineAgentDir();
  const manager = SessionManager.inMemory(dir);
  manager.appendMessage({ role: "user", content: "Before the profile", timestamp: 1 });
  manager.appendMessage(fauxAssistantMessage("Noted.", { timestamp: 2 }));
  const before = manager.getLeafId()!;
  manager.appendCustomEntry(MAIN_AGENT_ENTRY, {
    version: 1,
    profile: {
      name: "reviewer",
      displayName: "Reviewer",
      description: "Reviews changes",
      promptMode: "append",
      systemPrompt: "Review.",
    },
  });
  const withProfile = manager.getLeafId()!;

  let bus: ActionBus | undefined;
  const changed: string[] = [];
  const h = await startParent({
    dir,
    manager,
    extensions: [
      (pi) => {
        bus = pi.events;
        onViewChanged(pi.events, (id) => changed.push(id));
      },
    ],
  });
  const summary = () => {
    const model = readView(bus!, SUBAGENT_SUMMARY_VIEW);
    expect(isViewModel("summary", model)).toBe(true);
    return model as SummaryModel;
  };
  // Restored at start: the profile, and no subagent at all.
  expect(summary().profile).toEqual({
    name: "reviewer",
    label: "Reviewer",
    description: "Reviews changes",
  });
  expect(counts(summary()).total).toBe(0);

  changed.length = 0;
  await h.session.navigateTree(before, { summarize: false });
  expect(changed).toContain(SUBAGENT_SUMMARY_VIEW);
  expect(summary().profile).toBeUndefined();

  changed.length = 0;
  await h.session.navigateTree(withProfile, { summarize: false });
  expect(changed).toContain(SUBAGENT_SUMMARY_VIEW);
  expect(summary().profile?.name).toBe("reviewer");
}, 30_000);

it("settles a saved snapshot's running subagents and leaves the tasks as they were", async () => {
  let bus: ActionBus | undefined;
  const h = await startParent({
    tools: TODO_TOOLS,
    extensions: [todoExtension, (pi) => void (bus = pi.events)],
  });
  const child = gated(fauxAssistantMessage("Finished."));
  h.script({
    parent: [
      toolCall("todo_upsert", {
        tasks: [
          { key: "1", subject: "Write the collector", status: "in_progress" },
          { key: "2", subject: "Review it" },
        ],
      }),
      delegate("Work"),
      fauxAssistantMessage("Started."),
      fauxAssistantMessage("Noted."),
    ],
    child: [child.step],
  });
  await h.session.prompt("Plan and delegate");
  await child.started;
  const [id] = h.agentIds();

  const live = collectViews(bus!);
  for (const entry of live) expect(isViewModel(entry.kind, entry.model)).toBe(true);
  const settled = settleViews(live, Date.now());
  const find = (views: ViewEntry[], viewId: string) =>
    views.find((entry) => entry.id === viewId)?.model;

  // Tasks are persisted: their summary and widget settle unchanged, the task in progress too.
  for (const viewId of ["todo.summary", "todo.widget"])
    expect(find(settled, viewId)).toEqual(find(live, viewId));
  expect((find(settled, "todo.summary") as SummaryModel).active).toEqual({
    id: "1",
    label: "Write the collector",
  });

  // The running subagent was this process's: its count reads 0, finished history stays.
  const liveSummary = find(live, SUBAGENT_SUMMARY_VIEW) as SummaryModel;
  expect(counts(liveSummary)).toMatchObject({ running: 1, total: 1 });
  expect(liveSummary.active).toMatchObject({ id, live: true });
  const settledSummary = find(settled, SUBAGENT_SUMMARY_VIEW) as SummaryModel;
  expect(counts(settledSummary)).toEqual({
    running: 0,
    queued: 0,
    waiting: 0,
    completed: 0,
    failed: 0,
    stopped: 0,
    // Less the live counts, the agent that stopped with the process reads as finished.
    total: 1,
  });
  expect(settledSummary.active).toBeUndefined();

  // The widget's heading goes idle and its row reads "stopped", its clock stopped where it was.
  const liveWidget = find(live, "subagent.widget") as WidgetModel;
  const widget = find(settled, "subagent.widget") as WidgetModel;
  expect(liveWidget.active).toBe(true);
  expect(widget.active).toBe(false);
  expect(widget.meta).toEqual([]);
  expect(widget.rows).toHaveLength(1);
  const [row] = widget.rows;
  expect(row).toMatchObject({
    lead: { text: (liveWidget.rows[0]!.lead as { text: string }).text, tone: "dim" },
    left: liveWidget.rows[0]!.left,
    right: [
      [
        { text: "■", tone: "dim", icon: "stopped" },
        { text: " stopped", tone: "dim" },
      ],
    ],
    group: "stopped",
  });
  expect(row!.lead).not.toHaveProperty("since");
  expect(JSON.stringify(widget)).not.toContain('"live"');
  expect(isViewModel("widget", widget)).toBe(true);

  // The explorer's badge reads "stopped".
  expect((find(settled, "subagent.explorer") as ExplorerModel).items).toMatchObject([
    { id, badge: { text: "stopped", tone: "dim" } },
  ]);

  child.release();
  await untilAnnounced(h);
  await h.session.waitForIdle();
  // A finished agent is history: nothing about it is process-bound.
  const after = collectViews(bus!);
  const afterSettled = settleViews(after, Date.now());
  expect(counts(find(afterSettled, SUBAGENT_SUMMARY_VIEW) as SummaryModel)).toEqual(
    counts(find(after, SUBAGENT_SUMMARY_VIEW) as SummaryModel),
  );
  expect(counts(find(after, SUBAGENT_SUMMARY_VIEW) as SummaryModel)).toMatchObject({
    running: 0,
    completed: 1,
  });
  expect(find(afterSettled, "subagent.widget")).toEqual(find(after, "subagent.widget"));
  expect((find(afterSettled, "subagent.explorer") as ExplorerModel).items).toMatchObject([
    { id, badge: { text: "done", tone: "success" } },
  ]);
}, 30_000);
