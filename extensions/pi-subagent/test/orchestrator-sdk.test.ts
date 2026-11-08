import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import {
  EXTENSIONS,
  offlineAgentDir,
  realChildSession,
  BUILTIN_TOOLS,
  TODO_TOOLS,
  SUBAGENT_TOOLS,
  agentIdIn,
  lastResult,
} from "./helpers/sdk.ts";
import { toolCall } from "../../../packages/pi-test-helpers/src/faux-session.ts";

// Scripted model responses exercise the real SDK, extensions, todo journals,
// nested worker creation, and resume. This tests capabilities, not model judgment.
it("a child orchestrator tracks work, delegates an implementation, and recalls the same worker", async () => {
  const dir = offlineAgentDir({ extensions: [EXTENSIONS.subagent, EXTENSIONS.todo] });
  const registry = new AgentTypeRegistry(() => new Map());
  const parentTools = [...BUILTIN_TOOLS, ...TODO_TOOLS, ...SUBAGENT_TOOLS];
  const { session: orchestrator, faux } = await realChildSession(dir, {
    type: "orchestrate",
    provider: "orchestrator-test",
    parentTools,
    systemPrompt: `PROJECT BASE\nCurrent working directory: ${dir}`,
    registry,
  });
  expect(orchestrator.session.getActiveToolNames()).toEqual(expect.arrayContaining(parentTools));
  let workerId: string | undefined;
  const text = (value: unknown) => JSON.stringify(value);
  faux.setResponses([
    toolCall("todo_upsert", {
      tasks: [
        { key: "implement", subject: "Implementation: create artifact", status: "in_progress" },
      ],
    }),
    toolCall("subagent_start", {
      subagent_type: "general-purpose",
      description: "Implement artifact",
      prompt:
        "Create artifact.txt with verified content. Remember the design rationale for follow-up.",
    }),
    (context) => {
      const names = context.messages.flatMap((message) =>
        message.role === "system" ? (message.toolsAdded?.map((tool) => tool.name) ?? []) : [],
      );
      expect(names).toContain("write");
      for (const name of ["subagent_start", "subagent_get", "subagent_steer"])
        expect(names).not.toContain(name);
      return toolCall("todo_upsert", {
        tasks: [{ key: "worker-private", subject: "Worker-only notes" }],
      });
    },
    toolCall("write", { path: join(dir, "artifact.txt"), content: "verified content" }),
    fauxAssistantMessage("Artifact implemented. Rationale: preserve worker context."),
    (context) => {
      const result = lastResult(context, "subagent_start");
      expect(result).toContain("Artifact implemented");
      workerId = agentIdIn(result);
      expect(workerId).toBeTruthy();
      return toolCall("todo_upsert", {
        tasks: [{ key: "implement", description: `Owner: ${workerId}; follow up on rationale` }],
      });
    },
    () =>
      toolCall("subagent_start", {
        subagent_type: "general-purpose",
        resume: workerId!,
        description: "Recall rationale",
        prompt: "Explain the rationale you retained.",
      }),
    (context) => {
      expect(text(context.messages)).toContain(
        "Artifact implemented. Rationale: preserve worker context.",
      );
      return fauxAssistantMessage("Recalled rationale from the original worker conversation.");
    },
    () => toolCall("subagent_get", { agent_id: workerId!, verbose: true }),
    (context) => {
      expect(text(context.messages.at(-1))).toContain("Recalled rationale");
      return toolCall("todo_upsert", {
        tasks: [
          {
            key: "implement",
            status: "completed",
            description: `Owner: ${workerId}; artifact verified; rationale recalled`,
          },
        ],
      });
    },
    fauxAssistantMessage("Project complete; artifact verified and original worker recalled."),
  ]);
  const result = await orchestrator.runTurnLoop("Coordinate the artifact project.", {});
  expect(
    result.responseText,
    text(orchestrator.session.messages.filter((message) => message.role === "toolResult")),
  ).toContain("Project complete");
  expect(readFileSync(join(dir, "artifact.txt"), "utf8")).toBe("verified content");
  expect(faux.getPendingResponseCount()).toBe(0);
  const journal = orchestrator.session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "todo:journal");
  expect(journal.at(-1)).toMatchObject({
    data: {
      tasks: [
        {
          key: "implement",
          status: "completed",
          description: expect.stringContaining(workerId!),
        },
      ],
    },
  });
  // The worker's separate todo list must not leak into the project ledger.
  expect(text(journal.at(-1))).not.toContain("worker-private");
}, 20_000);
