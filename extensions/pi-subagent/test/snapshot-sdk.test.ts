import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import type { SubagentSnapshot } from "#src/observation/snapshot";
import { delegate, gated, startParent, untilAnnounced } from "./characterization/harness.ts";

it("publishes live state, restores finished history on reload, and replaces the roster after /tree", async () => {
  const snapshots: SubagentSnapshot[] = [];
  const h = await startParent({
    extensions: [
      (pi) => {
        pi.events.on("subagent:snapshot", (data) => snapshots.push(data as SubagentSnapshot));
      },
    ],
  });
  expect(snapshots.at(-1)).toEqual({ version: 1, agents: [] });
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
  expect(snapshots.at(-1)?.agents[0]).toMatchObject({ id, state: "running", live: true });
  child.release();
  await untilAnnounced(h);
  await h.session.waitForIdle();
  expect(snapshots.at(-1)?.agents[0]).toMatchObject({ id, state: "completed" });
  const beforeReload = snapshots.length;
  await h.session.reload();
  expect(snapshots.length).toBeGreaterThan(beforeReload);
  expect(snapshots.at(-1)?.agents[0]).toMatchObject({ id, state: "completed", live: false });
  await h.session.navigateTree(beforeSpawn, { summarize: false });
  expect(snapshots.at(-1)).toEqual({ version: 1, agents: [] });
}, 30_000);
