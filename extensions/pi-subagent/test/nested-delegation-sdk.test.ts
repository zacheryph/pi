import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, it, vi } from "vitest";
import { WORK_WAKE_PROMPT } from "#src/lifecycle/run";
import { toolCall } from "../../../packages/pi-test-helpers/src/faux-session.ts";
import { resetSessionTree } from "../../../packages/pi-test-helpers/src/globals.ts";
import { gated, startParent, untilAnnounced, type Step } from "./characterization/harness.ts";
import { EXTENSIONS, offlineAgentDir } from "./helpers/sdk.ts";
import { widgetUi } from "./helpers/widget-ui.ts";

// Nested delegation needs no code of its own (roadmap step 9): the agents a child starts are items
// in the child's own work host, so a child orchestrator that ends its turn with a worker running
// is idle and waiting, and the worker's completion wakes it through the root's manager.

afterEach(resetSessionTree);

type Side = "parent" | "orchestrator" | "worker";

/** Which of the three sessions is asking: the marker its prompt starts with. */
function sideOf(context: Context): Side {
  const prompts = context.messages
    .filter((message) => message.role === "user")
    .map((message) => JSON.stringify(message.content));
  if (prompts.some((prompt) => prompt.includes("[worker]"))) return "worker";
  if (prompts.some((prompt) => prompt.includes("[orchestrator]"))) return "orchestrator";
  return "parent";
}

it("a child orchestrator whose worker is still running is waiting, and wakes on its completion", async () => {
  const dir = offlineAgentDir({ extensions: [EXTENSIONS.subagent] });
  const ui = widgetUi();
  const h = await startParent({ dir, bind: { uiContext: ui.uiContext } });

  const worker = gated(fauxAssistantMessage("Parser fixed."));
  const requests: Record<Side, Context[]> = { parent: [], orchestrator: [], worker: [] };
  const queues: Record<Side, Array<Step>> = {
    parent: [
      toolCall("subagent_start", {
        subagent_type: "orchestrate",
        description: "Coordinate the parser fix",
        prompt: "[orchestrator] Get the parser fixed by a worker, then report.",
      }),
      fauxAssistantMessage("Started."),
      fauxAssistantMessage("Noted."),
    ],
    orchestrator: [
      toolCall("subagent_start", {
        subagent_type: "general-purpose",
        description: "Fix parser",
        prompt: "[worker] Fix the parser.",
      }),
      fauxAssistantMessage("Delegated; waiting for the worker."),
      fauxAssistantMessage("The worker fixed the parser. All done."),
    ],
    worker: [worker.step],
  };
  h.faux.setResponses(
    Array.from({ length: 60 }, () => async (context: Context, _options?: SimpleStreamOptions) => {
      const side = sideOf(context);
      requests[side].push(structuredClone(context));
      const reply = queues[side].shift();
      if (!reply) return fauxAssistantMessage("(unscripted)");
      return typeof reply === "function" ? reply(context, _options) : reply;
    }),
  );

  await h.session.prompt("Get the parser fixed");

  // The orchestrator's run ended while its worker was still running. It is idle and waiting, the
  // root shows it so, and it has reported nothing.
  await worker.started;
  await vi.waitFor(() => expect(ui.text()).toContain("waiting: Fix parser"), { timeout: 15_000 });
  expect(ui.text()).toContain("Coordinate the parser fix");
  expect(ui.status()).toBe("1 waiting agent");
  const [orchestrator] = h.agentIds();
  expect(h.seen("subagent:waiting")).toMatchObject([{ data: { id: orchestrator } }]);
  expect(h.announcements()).toEqual([]);
  expect(requests.parent).toHaveLength(2);
  expect(requests.orchestrator).toHaveLength(2);

  // The worker finishes. Its completion lands in the orchestrator's transcript, and the root's
  // manager gives the orchestrator the run that answers it.
  worker.release();
  await untilAnnounced(h);
  expect(requests.orchestrator).toHaveLength(3);
  const woken = JSON.stringify(requests.orchestrator[2].messages);
  expect(woken).toContain("<task-notification>");
  expect(woken).toContain("Parser fixed.");
  expect(woken.indexOf("Parser fixed.")).toBeLessThan(woken.indexOf(WORK_WAKE_PROMPT));
  expect(h.seen("subagent:resuming")).toMatchObject([{ data: { id: orchestrator } }]);

  // Done: the parent hears from the orchestrator once, and only now.
  expect(h.announcements()).toHaveLength(1);
  expect(h.announcements()[0].text).toContain("The worker fixed the parser. All done.");
  const done = ui.frames.findIndex((frame) => /Coordinate the parser fix .* ✓ done/.test(frame));
  expect(done).toBeGreaterThan(-1);
  await vi.waitFor(() => expect(requests.parent).toHaveLength(3), { timeout: 15_000 });
  expect(h.errors).toEqual([]);
}, 40_000);
