import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import {
  listViews,
  onViewChanged,
  readView,
  type ActionBus,
  type ExplorerModel,
  type WidgetModel,
} from "#surface";
import { SUBAGENT_EXPLORER_VIEW, SUBAGENT_WIDGET_VIEW } from "#src/observation/snapshot";
import { delegate, gated, startParent, untilAnnounced } from "#test/characterization/harness";

it("offers the widget and the branch's subagents as views, announced as agents change", async () => {
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
    { id: SUBAGENT_WIDGET_VIEW, kind: "widget", title: "Subagents" },
  ]);
  expect(readView(bus!, SUBAGENT_WIDGET_VIEW)).toBeUndefined();
  expect((readView(bus!, SUBAGENT_EXPLORER_VIEW) as ExplorerModel).items).toEqual([]);

  const child = gated(fauxAssistantMessage("Finished."));
  h.script({
    parent: [delegate("Work"), fauxAssistantMessage("Started."), fauxAssistantMessage("Noted.")],
    child: [child.step],
  });
  changed.length = 0;
  await h.session.prompt("Delegate work");
  await child.started;
  const [id] = h.agentIds();
  expect(changed).toEqual(expect.arrayContaining([SUBAGENT_WIDGET_VIEW, SUBAGENT_EXPLORER_VIEW]));
  const running = readView(bus!, SUBAGENT_WIDGET_VIEW) as WidgetModel;
  expect(running.active).toBe(true);
  expect(running.rows).toHaveLength(1);
  expect((readView(bus!, SUBAGENT_EXPLORER_VIEW) as ExplorerModel).items).toMatchObject([
    { id, badge: { text: "running" } },
  ]);

  child.release();
  await untilAnnounced(h);
  await h.session.waitForIdle();
  expect((readView(bus!, SUBAGENT_EXPLORER_VIEW) as ExplorerModel).items).toMatchObject([
    { id, badge: { text: "done" } },
  ]);

  // A reload defines them again on the same bus, once.
  await h.session.reload();
  expect(listViews(bus!).map((view) => view.id)).toEqual([
    SUBAGENT_EXPLORER_VIEW,
    SUBAGENT_WIDGET_VIEW,
  ]);
}, 30_000);
