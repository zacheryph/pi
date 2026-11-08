import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { EXTENSIONS, offlineAgentDir, realChildSession, lastResult } from "./helpers/sdk.ts";
import { toolCall } from "../../../packages/pi-test-helpers/src/faux-session.ts";

// A real orchestrator session loads this extension and pi-ask, and spawns a
// worker whose `ask` call turns toward the orchestrator: the question lands on
// the worker's record and in the orchestrator's subagent_start result.
it("routes a child's ask to its parent through pi-ask", async () => {
  const dir = offlineAgentDir({ extensions: [EXTENSIONS.subagent, EXTENSIONS.ask] });
  const { session: orchestrator, faux } = await realChildSession(dir, {
    type: "orchestrate",
    provider: "ask-test",
  });
  let childTools: string[] = [];
  let spawnResult = "";
  faux.setResponses([
    toolCall("subagent_start", {
      subagent_type: "general-purpose",
      description: "Pick storage",
      prompt: "Set up storage.",
    }),
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
      const recorded = lastResult(context, "ask");
      expect(recorded).toContain("End your turn now");
      return fauxAssistantMessage("Waiting for the storage decision.");
    },
    (context) => {
      const result = lastResult(context, "subagent_start");
      spawnResult = result;
      return fauxAssistantMessage("Asked.");
    },
  ]);

  await orchestrator.runTurnLoop("Delegate storage.", {});
  expect(faux.getPendingResponseCount()).toBe(0);
  expect(childTools).toContain("ask");
  expect(spawnResult).toContain("[Storage] Which database?");
  expect(spawnResult).toContain("a) Postgres");
  expect(spawnResult).toContain("resume");
}, 20_000);
