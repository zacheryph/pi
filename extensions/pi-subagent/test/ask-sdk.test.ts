import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import {
  EXTENSIONS,
  lastResult,
  offlineAgentDir,
  realChildSession,
  scriptSides,
  spawnChild,
} from "#test/helpers/sdk";
import { toolCall } from "#test-helpers";

// A real orchestrator session loads this extension and pi-ask, and spawns a
// worker whose `ask` call turns toward the orchestrator.
//
// Rewritten by roadmap step 10 (was: "routes a child's ask to its parent through pi-ask": the
// worker's question was recorded on its run, the worker ended its turn on a prose instruction and
// completed carrying the question, and the question reached the orchestrator in the worker's
// *completion* message). Now the question is an item in the worker's work host, the ask tool
// terminates the worker's turn, and the orchestrator hears it in a `subagent:question` message
// while the worker is idle and waiting: no completion yet. The end-to-end round trip, the
// roster, a watch open beside the question and the reload cases are in question-sdk.test.ts.
it("routes a child's ask to its parent through pi-ask: a question message, no completion", async () => {
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
        return fauxAssistantMessage("Not reached: the ask call ended the turn.");
      },
    ],
  });

  await orchestrator.runTurnLoop("Delegate storage.", {});
  // The worker's question wakes the orchestrator once more.
  await vi.waitFor(() => expect(requests.parent).toHaveLength(3), { timeout: 10_000 });
  await orchestrator.session.waitForIdle();

  expect(childTools).toContain("ask");
  const question = JSON.stringify(requests.parent[2].messages.at(-1));
  expect(question).toContain("<subagent-question>");
  expect(question).not.toContain("<task-notification>");
  expect(question).toContain("[Storage] Which database?");
  expect(question).toContain("a) Postgres");
  expect(question).toContain("subagent_send");
  // The ask call ended the worker's turn: the model was not asked again, so it never saw the result.
  expect(requests.child).toHaveLength(1);
  expect(recorded).toBe("");
}, 20_000);
