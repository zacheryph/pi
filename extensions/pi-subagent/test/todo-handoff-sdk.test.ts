import { type Context, getCurrentTools } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import {
  CHILD_MARK,
  EXTENSIONS,
  scriptSides,
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
          prompt: `${CHILD_MARK} Audit auth and write its tests.`,
          handoff: { todo: { keys } },
        },
        id,
      );
    const toolNames = (context: Context) =>
      getCurrentTools(context.messages).map((tool) => tool.name);
    const seen: {
      unassignedTools: string[];
      badHandoff: string;
      assignedTools: string[];
      listed: string;
      denied: string;
    } = { unassignedTools: [], badHandoff: "", assignedTools: [], listed: "", denied: "" };
    const { queues } = scriptSides(faux, {
      parent: [
        // A restricted worker without a handoff still has no todo tools.
        toolCall("subagent_start", {
          subagent_type: workerType,
          model: "todo-handoff-test/coordinator",
          description: "Unassigned worker",
          prompt: `${CHILD_MARK} Report only.`,
        }),
        fauxAssistantMessage("Unassigned worker started."),
        // Its completion message wakes the orchestrator.
        toolCall("todo_upsert", {
          tasks: [
            { key: "audit", subject: "Audit auth" },
            { key: "tests", subject: "Write auth tests" },
            { key: "ship", subject: "Ship release" },
          ],
        }),
        spawn(["missing"], "call-bad"),
        (context) => {
          seen.badHandoff = lastResult(context, "subagent_start");
          return spawn(["audit", "tests"], "call-spawn");
        },
        fauxAssistantMessage("Audit worker started."),
        // The audit worker's completion message wakes the orchestrator again.
        toolCall("todo_list", {}),
        fauxAssistantMessage("Delegated."),
      ],
      child: [
        (context) => {
          seen.unassignedTools = toolNames(context);
          return fauxAssistantMessage("Unassigned worker finished.");
        },
        // The worker sees actual SDK tool declarations on its very first request.
        (context) => {
          seen.assignedTools = toolNames(context);
          return toolCall("todo_list", {});
        },
        (context) => {
          seen.listed = lastResult(context, "todo_list");
          return toolCall("todo_upsert", {
            tasks: [
              { key: "audit", status: "completed", message: "Session cookie path is sound." },
              { key: "rotate-key", subject: "Rotate signing key", dependsOn: ["audit"] },
            ],
          });
        },
        toolCall("todo_upsert", { tasks: [{ key: "ship", status: "completed" }] }),
        (context) => {
          seen.denied = lastResult(context, "todo_upsert");
          return fauxAssistantMessage("Audit finished; follow-up added.");
        },
      ],
    });

    await orchestrator.runTurnLoop("Delegate the auth work.", {});
    await vi.waitFor(() => expect(queues.parent).toHaveLength(0), { timeout: 15_000 });
    await orchestrator.session.waitForIdle();
    expect(queues.child).toHaveLength(0);

    if (workerType !== "general-purpose") {
      expect(seen.unassignedTools.filter((name) => name.startsWith("todo_"))).toEqual([]);
      expect(seen.unassignedTools).not.toContain("edit");
      expect(seen.unassignedTools).not.toContain("write");
    }
    expect(seen.badHandoff).toContain("Cannot hand off todo tasks: unknown task: missing");
    expect(seen.assignedTools).toContain("todo_list");
    expect(seen.assignedTools).toContain("todo_upsert");
    expect(seen.assignedTools).not.toContain("subagent_start");
    if (workerType !== "general-purpose") {
      expect(seen.assignedTools.filter((name) => name.startsWith("todo_"))).toEqual([
        "todo_list",
        "todo_upsert",
      ]);
      expect(seen.assignedTools).not.toContain("edit");
      expect(seen.assignedTools).not.toContain("write");
    }
    expect(seen.listed).toContain("audit");
    expect(seen.listed).toContain("tests");
    expect(seen.listed).not.toContain("ship");
    expect(seen.denied).toContain("task ship is not assigned to you");

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
