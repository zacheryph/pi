import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { onViewChanged, readView, type ExplorerModel } from "#surface";
import { SUBAGENT_EXPLORER_VIEW } from "#src/observation/snapshot";
import { delegate, gated, startParent, untilAnnounced } from "#test/characterization/harness";

it("publishes live state, restores finished history on reload, and replaces the roster after /tree", async () => {
  let bus: EventBus | undefined;
  let announced = 0;
  const h = await startParent({
    extensions: [
      (pi) => {
        bus = pi.events;
        onViewChanged(pi.events, (id) => {
          if (id === SUBAGENT_EXPLORER_VIEW) announced++;
        });
      },
    ],
  });
  /** The branch's agents as the `subagent.explorer` view lists them: id and state badge. */
  const roster = () =>
    (readView(bus!, SUBAGENT_EXPLORER_VIEW) as ExplorerModel).items.map((item) => [
      item.id,
      item.badge?.text,
    ]);
  expect(roster()).toEqual([]);
  h.script({ parent: [fauxAssistantMessage("Hello.")] });
  await h.session.prompt("Hello");
  const beforeSpawn = h.manager.getLeafId()!;
  const child = gated(fauxAssistantMessage("Finished."));
  h.script({
    parent: [delegate("Work"), fauxAssistantMessage("Started."), fauxAssistantMessage("Noted.")],
    child: [child.step],
  });
  await h.session.prompt("Delegate work");
  await child.started;
  const [id] = h.agentIds();
  expect(roster()).toEqual([[id, "running"]]);
  child.release();
  await untilAnnounced(h);
  await h.session.waitForIdle();
  expect(roster()).toEqual([[id, "done"]]);
  const beforeReload = announced;
  await h.session.reload();
  expect(announced).toBeGreaterThan(beforeReload);
  expect(roster()).toEqual([[id, "done"]]);
  await h.session.navigateTree(beforeSpawn, { summarize: false });
  expect(roster()).toEqual([]);
}, 30_000);
