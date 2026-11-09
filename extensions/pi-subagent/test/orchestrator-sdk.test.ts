import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import {
  EXTENSIONS,
  offlineAgentDir,
  realChildSession,
  BUILTIN_TOOLS,
  TODO_TOOLS,
  SUBAGENT_TOOLS,
  agentIdIn,
  CHILD_MARK,
  lastResult,
  scriptSides,
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
  let workerTools: string[] = [];
  let workerSawRationale = false;
  let firstCompletion = "";
  let recalled = "";
  const text = (value: unknown) => JSON.stringify(value);
  const { queues } = scriptSides(faux, {
    parent: [
      toolCall("todo_upsert", {
        tasks: [
          { key: "implement", subject: "Implementation: create artifact", status: "in_progress" },
        ],
      }),
      toolCall("subagent_start", {
        subagent_type: "general-purpose",
        description: "Implement artifact",
        prompt: `${CHILD_MARK} Create artifact.txt with verified content. Remember the design rationale for follow-up.`,
      }),
      // The worker runs in the background: the orchestrator ends its turn and the
      // worker's completion message wakes it.
      fauxAssistantMessage("Worker started; waiting for its completion."),
      (context) => {
        workerId = agentIdIn(lastResult(context, "subagent_start"));
        firstCompletion = text(context.messages.at(-1));
        return toolCall("todo_upsert", {
          tasks: [{ key: "implement", description: `Owner: ${workerId}; follow up on rationale` }],
        });
      },
      () =>
        toolCall("subagent_start", {
          subagent_type: "general-purpose",
          resume: workerId!,
          description: "Recall rationale",
          prompt: `${CHILD_MARK} Explain the rationale you retained.`,
        }),
      fauxAssistantMessage("Recall requested."),
      () => toolCall("subagent_get", { agent_id: workerId!, verbose: true }),
      (context) => {
        recalled = text([context.messages.at(-2), context.messages.at(-1)]);
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
    ],
    child: [
      (context) => {
        workerTools = context.messages.flatMap((message) =>
          message.role === "system" ? (message.toolsAdded?.map((tool) => tool.name) ?? []) : [],
        );
        return toolCall("todo_upsert", {
          tasks: [{ key: "worker-private", subject: "Worker-only notes" }],
        });
      },
      toolCall("write", { path: join(dir, "artifact.txt"), content: "verified content" }),
      fauxAssistantMessage("Artifact implemented. Rationale: preserve worker context."),
      (context) => {
        workerSawRationale = text(context.messages).includes(
          "Artifact implemented. Rationale: preserve worker context.",
        );
        return fauxAssistantMessage("Recalled rationale from the original worker conversation.");
      },
    ],
  });
  await orchestrator.runTurnLoop("Coordinate the artifact project.", {});
  // Both completion messages wake the orchestrator; it is done once its last reply is given.
  await vi.waitFor(() => expect(queues.parent).toHaveLength(0), { timeout: 15_000 });
  await orchestrator.session.waitForIdle();
  expect(workerTools).toContain("write");
  for (const name of ["subagent_start", "subagent_get", "subagent_steer"])
    expect(workerTools).not.toContain(name);
  expect(workerId).toBeTruthy();
  expect(firstCompletion).toContain("Artifact implemented");
  expect(workerSawRationale).toBe(true);
  expect(recalled).toContain("Recalled rationale");
  expect(queues.child).toHaveLength(0);
  const finalText = text(orchestrator.session.messages.at(-1));
  expect(
    finalText,
    text(orchestrator.session.messages.filter((m) => m.role === "toolResult")),
  ).toContain("Project complete");
  expect(readFileSync(join(dir, "artifact.txt"), "utf8")).toBe("verified content");
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
