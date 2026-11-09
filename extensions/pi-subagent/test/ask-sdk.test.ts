import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import {
  EXTENSIONS,
  lastResult,
  offlineAgentDir,
  realChildSession,
  scriptSides,
  spawnChild,
} from "./helpers/sdk.ts";
import { toolCall } from "../../../packages/pi-test-helpers/src/faux-session.ts";

// A real orchestrator session loads this extension and pi-ask, and spawns a
// worker whose `ask` call turns toward the orchestrator: the worker ends its
// turn with the question, and the question reaches the orchestrator in the
// worker's completion message.
it("routes a child's ask to its parent through pi-ask", async () => {
  const dir = offlineAgentDir({ extensions: [EXTENSIONS.subagent, EXTENSIONS.ask] });
  const { session: orchestrator, faux } = await realChildSession(dir, {
    type: "orchestrate",
    provider: "ask-test",
  });
  let childTools: string[] = [];
  let recorded = "";
  const { requests } = scriptSides(faux, {
    parent: [spawnChild("Pick storage"), fauxAssistantMessage("Asked.")],
    child: [
      (context) => {
        childTools = context.messages.flatMap((message) =>
          message.role === "system" ? (message.toolsAdded?.map((tool) => tool.name) ?? []) : [],
        );
        return toolCall("ask", {
          questions: [
            {
              question: "Which database?",
              header: "Storage",
              options: [{ label: "Postgres" }, { label: "SQLite" }],
            },
          ],
        });
      },
      (context) => {
        recorded = lastResult(context, "ask");
        return fauxAssistantMessage("Waiting for the storage decision.");
      },
    ],
  });

  await orchestrator.runTurnLoop("Delegate storage.", {});
  // The worker's completion message wakes the orchestrator once more.
  await vi.waitFor(() => expect(requests.parent).toHaveLength(3), { timeout: 10_000 });
  await orchestrator.session.waitForIdle();

  expect(childTools).toContain("ask");
  expect(recorded).toContain("End your turn now");
  const completion = JSON.stringify(requests.parent[2].messages.at(-1));
  expect(completion).toContain("<task-notification>");
  expect(completion).toContain("[Storage] Which database?");
  expect(completion).toContain("a) Postgres");
  expect(completion).toContain("subagent_send");
}, 20_000);
