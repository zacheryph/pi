import { getCurrentTools } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import {
  EXTENSIONS,
  offlineAgentDir,
  realChildSession,
  BUILTIN_TOOLS,
  TODO_TOOLS,
  SUBAGENT_TOOLS,
  lastResult,
} from "./helpers/sdk.ts";
import { toolCall } from "../../../packages/pi-test-helpers/src/faux-session.ts";

// A real orchestrator session (pi-subagent + pi-todo) hands two tasks to a
// worker through handoff.todo. Scripted model responses, real SDK sessions.
it.each(["general-purpose", "explore", "plan", "review", "no-tools"])(
  "hands scoped todos to %s without widening other capabilities",
  async (workerType) => {
    const dir = offlineAgentDir({
      extensions: [EXTENSIONS.subagent, EXTENSIONS.todo],
      files: {
        "agents/no-tools.md":
          "---\ndescription: No capability tools\ntools: none\n---\nReport only.\n",
      },
    });
    const parentTools = [...BUILTIN_TOOLS, ...TODO_TOOLS, ...SUBAGENT_TOOLS];
    const { session: orchestrator, faux } = await realChildSession(dir, {
      type: "orchestrate",
      provider: "todo-handoff-test",
      parentTools,
    });
    const spawn = (keys: string[], id: string) =>
      toolCall(
        "subagent_start",
        {
          subagent_type: workerType,
          model: "todo-handoff-test/coordinator",
          description: "Audit auth",
          prompt: "Audit auth and write its tests.",
          handoff: { todo: { keys } },
        },
        id,
      );
    faux.setResponses([
      // A restricted worker without a handoff still has no todo tools.
      toolCall("subagent_start", {
        subagent_type: workerType,
        model: "todo-handoff-test/coordinator",
        description: "Unassigned worker",
        prompt: "Report only.",
      }),
      (context) => {
        const tools = getCurrentTools(context.messages).map((tool) => tool.name);
        if (workerType !== "general-purpose") {
          expect(tools.filter((name) => name.startsWith("todo_"))).toEqual([]);
          expect(tools).not.toContain("edit");
          expect(tools).not.toContain("write");
        }
        return fauxAssistantMessage("Unassigned worker finished.");
      },
      toolCall("todo_upsert", {
        tasks: [
          { key: "audit", subject: "Audit auth" },
          { key: "tests", subject: "Write auth tests" },
          { key: "ship", subject: "Ship release" },
        ],
      }),
      spawn(["missing"], "call-bad"),
      (context) => {
        expect(lastResult(context, "subagent_start")).toContain(
          "Cannot hand off todo tasks: unknown task: missing",
        );
        return spawn(["audit", "tests"], "call-spawn");
      },
      // The worker sees actual SDK tool declarations on its very first request.
      (context) => {
        const tools = getCurrentTools(context.messages).map((tool) => tool.name);
        expect(tools).toContain("todo_list");
        expect(tools).toContain("todo_upsert");
        expect(tools).not.toContain("subagent_start");
        if (workerType !== "general-purpose") {
          expect(tools.filter((name) => name.startsWith("todo_"))).toEqual([
            "todo_list",
            "todo_upsert",
          ]);
          expect(tools).not.toContain("edit");
          expect(tools).not.toContain("write");
        }
        return toolCall("todo_list", {});
      },
      (context) => {
        const listed = lastResult(context, "todo_list");
        expect(listed).toContain("audit");
        expect(listed).toContain("tests");
        expect(listed).not.toContain("ship");
        return toolCall("todo_upsert", {
          tasks: [
            { key: "audit", status: "completed", message: "Session cookie path is sound." },
            { key: "rotate-key", subject: "Rotate signing key", dependsOn: ["audit"] },
          ],
        });
      },
      toolCall("todo_upsert", { tasks: [{ key: "ship", status: "completed" }] }),
      (context) => {
        expect(lastResult(context, "todo_upsert")).toContain("task ship is not assigned to you");
        return fauxAssistantMessage("Audit finished; follow-up added.");
      },
      // Back in the orchestrator.
      toolCall("todo_list", {}),
      fauxAssistantMessage("Delegated."),
    ]);

    await orchestrator.runTurnLoop("Delegate the auth work.", {});
    expect(faux.getPendingResponseCount()).toBe(0);

    const branch = orchestrator.session.sessionManager.getBranch();
    const journal = branch
      .filter((entry) => entry.type === "custom" && entry.customType === "todo:journal")
      .at(-1) as {
      data: {
        tasks: { key: string; status: string }[];
        activity: Record<string, { updates: { message?: string; agent?: string }[] }>;
      };
    };
    expect(journal.data.tasks.map((task) => [task.key, task.status])).toEqual([
      ["audit", "completed"],
      ["tests", "pending"],
      ["ship", "pending"],
      ["rotate-key", "pending"],
    ]);
    const audit = journal.data.activity.audit.updates.find(
      (update) => update.message === "Session cookie path is sound.",
    );
    expect(audit?.agent).toEqual(expect.any(String));
    const claims = branch
      .filter((entry) => entry.type === "custom" && entry.customType === "todo:claim")
      .map((entry) => (entry as { data: { op: string; agent: string; keys?: string[] } }).data);
    expect(claims.map((entry) => [entry.op, entry.keys])).toEqual([
      ["claim", ["audit", "tests"]],
      ["claim", ["rotate-key"]],
      ["release", undefined],
    ]);
    expect(new Set(claims.map((entry) => entry.agent))).toEqual(new Set([audit!.agent]));
  },
  30_000,
);
