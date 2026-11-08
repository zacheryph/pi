import { resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createCodemodeExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, onTestFinished } from "vitest";
import todoExtension from "#src/index";
import { loadTodoConfig } from "#src/config";
import { replayTodoState } from "#src/state";
import {
  replayTaskState,
  replayTodoSession,
  TODO_JOURNAL_TYPE,
  TODO_REVIEW_TYPE,
} from "#src/replay";
import {
  fauxSession,
  loadResources,
  toolCall,
} from "../../../packages/pi-test-helpers/src/faux-session.ts";
import { tempDir } from "../../../packages/pi-test-helpers/src/temp.ts";

async function fixture(
  options: {
    manager?: SessionManager;
    responses?: ReturnType<typeof fauxAssistantMessage>[];
    delayToolResult?: () => Promise<void>;
  } = {},
) {
  const dir = tempDir(onTestFinished, "pi-todo-sdk-");
  const h = await fauxSession({
    cleanup: onTestFinished,
    dir,
    provider: "todo-test",
    sessionManager: options.manager,
    responses: options.responses,
    tools: ["todo_list", "todo_upsert", "todo_replace", "todo_remove", "todo_clear", "codemode"],
    extensions: [
      (pi) => todoExtension(pi, { loadConfig: (cwd) => loadTodoConfig(cwd, dir) }),
      createCodemodeExtension(),
      (pi) => {
        if (options.delayToolResult)
          pi.on("tool_result", async (event) => {
            if (event.toolName.startsWith("todo_")) await options.delayToolResult!();
          });
      },
    ],
  });
  return { ...h, manager: h.sessionManager };
}

const nestedWrite = (after = 'return "hidden";') =>
  toolCall("codemode", {
    code: `await tools.todo_upsert({tasks:[{key:"inspect",subject:"Inspect",status:"in_progress"},{key:"verify",subject:"Verify",dependsOn:["inspect"]}]}); ${after}`,
  });

function snapshot(manager: SessionManager) {
  return replayTaskState({ sessionManager: manager });
}

describe("real Pi SDK integration (offline faux provider)", () => {
  it("loads standalone package with one tool per action and expected commands", async () => {
    const { extensions, errors } = await loadResources(onTestFinished, {
      packages: [resolve(import.meta.dirname, "..")],
    });
    expect(errors).toEqual([]);
    expect(extensions).toHaveLength(1);
    expect([...extensions[0].tools.keys()]).toEqual([
      "todo_list",
      "todo_upsert",
      "todo_replace",
      "todo_remove",
      "todo_clear",
    ]);
    expect([...extensions[0].commands.keys()]).toEqual([
      "todo",
      "todo:review",
      "todo:add",
      "todo:update",
      "todo:remove",
      "todo:clear",
      "todo:settings",
    ]);
  });

  it.each([
    ["suppressed result", 'return "hidden";'],
    ["later script failure", 'throw new Error("after write");'],
  ] as const)(
    "journals nested mutation with %s, replays through fresh loader",
    async (_label, after) => {
      const h = await fixture({ responses: [nestedWrite(after), fauxAssistantMessage("done")] });
      await h.session.prompt("Work");
      expect(h.requests).toHaveLength(2);
      expect(h.errors).toEqual([]);
      const branch = h.manager.getBranch();
      expect(
        branch.filter((entry) => entry.type === "custom" && entry.customType === TODO_JOURNAL_TYPE),
      ).toHaveLength(1);
      expect(
        branch.filter(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolName.startsWith("todo_"),
        ),
      ).toHaveLength(0);
      expect(snapshot(h.manager).tasks.map((task) => task.key)).toEqual(["inspect", "verify"]);
      const nextRequest = JSON.stringify(h.requests[1]);
      expect(nextRequest).toContain("Current task list (revision 1)");
      expect(nextRequest).toContain('\\"dependsOn\\":[\\"inspect\\"]');
      const reloaded = await fixture({ manager: h.manager });
      await reloaded.session.prompt("Resume");
      expect(JSON.stringify(reloaded.requests[0])).toContain("Current task list (revision 1)");
      expect(snapshot(reloaded.manager).tasks).toEqual(snapshot(h.manager).tasks);
    },
    20_000,
  );

  it("commands never call provider; next ordinary request sees exact changed/empty plan", async () => {
    const h = await fixture();
    await h.session.prompt("/todo:add Fix auth");
    expect(h.requests).toHaveLength(0);
    expect(snapshot(h.manager).tasks[0]).toMatchObject({ key: "fix-auth", status: "pending" });
    await h.session.prompt("Continue");
    expect(h.requests).toHaveLength(1);
    expect(JSON.stringify(h.requests[0])).toContain("Current task list (revision 1)");
    h.faux.setResponses([fauxAssistantMessage("still tracked")]);
    await h.session.prompt("Another request without direct todo results");
    expect(h.requests).toHaveLength(2);
    expect(JSON.stringify(h.requests[1])).toContain("Current task list (revision 1)");
    await h.session.prompt("/todo:clear all --yes");
    expect(h.requests).toHaveLength(2);
    h.faux.setResponses([fauxAssistantMessage("done again")]);
    await h.session.prompt("Next");
    expect(h.requests).toHaveLength(3);
    expect(JSON.stringify(h.requests[2])).toContain("Current task list (revision 2)");
    expect(snapshot(h.manager).tasks).toEqual([]);
  });

  it("delayed direct results cannot overwrite a newer command journal on reload", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const h = await fixture({
      responses: [
        toolCall("todo_upsert", { tasks: [{ key: "old", subject: "Old" }] }),
        fauxAssistantMessage("done"),
      ],
      delayToolResult: async () => {
        entered();
        await gate;
      },
    });
    const running = h.session.prompt("Work");
    await ready;
    await h.session.prompt("/todo:clear all --yes");
    expect(snapshot(h.manager).revision).toBe(2);
    release();
    await running;
    // Upstream tool-result-only replay would restore the late revision-one task.
    expect(replayTodoState({ sessionManager: h.manager }).tasks).toHaveLength(1);
    expect(snapshot(h.manager).tasks).toEqual([]);
    const restored = await fixture({ manager: h.manager });
    await restored.session.prompt("After reload");
    expect(snapshot(restored.manager).tasks).toEqual([]);
    expect(JSON.stringify(restored.requests[0])).toContain("Current task list (revision 2)");
  }, 20_000);

  it("real tree navigation restores branch-local state instead of abandoned additions", async () => {
    const h = await fixture();
    await h.session.prompt("/todo:add First work");
    const first = h.manager.getLeafId()!;
    await h.session.prompt("/todo:add Abandoned work");
    expect(snapshot(h.manager).tasks).toHaveLength(2);
    await h.session.navigateTree(first, { summarize: false });
    await h.session.prompt("Current branch");
    expect(snapshot(h.manager).tasks.map((task) => task.key)).toEqual(["first-work"]);
    const request = JSON.stringify(h.requests[0]);
    expect(request).toContain("first-work");
    expect(request).not.toContain("abandoned-work");
  });

  it("direct todo results provide persistent baseline, avoiding duplicate context snapshots", async () => {
    const h = await fixture({
      responses: [
        toolCall("todo_upsert", {
          tasks: [{ key: "tracked", subject: "Tracked" }],
        }),
        fauxAssistantMessage("done"),
      ],
    });
    await h.session.prompt("Work");
    const secondRequest = JSON.stringify(h.requests[1]);
    expect(secondRequest).toContain("tracked");
    expect(secondRequest).not.toContain("Current task list");
    h.faux.setResponses([fauxAssistantMessage("done again")]);
    await h.session.prompt("Still tracked");
    expect(JSON.stringify(h.requests[2])).not.toContain("Current task list");
    expect(snapshot(h.manager).tasks.map((task) => task.key)).toEqual(["tracked"]);
  });

  it("same-process independent loaders keep parent/child plans and checkpoints isolated", async () => {
    const parent = await fixture();
    const child = await fixture();
    await parent.session.prompt("/todo:add Parent work");
    await child.session.prompt("/todo:add Child work");
    await child.session.prompt("/todo:update child-work completed");
    expect(snapshot(parent.manager).tasks).toEqual([
      expect.objectContaining({ key: "parent-work", status: "pending" }),
    ]);
    expect(snapshot(child.manager).tasks).toEqual([
      expect.objectContaining({ key: "child-work", status: "completed" }),
    ]);
    expect(parent.requests).toHaveLength(0);
    expect(child.requests).toHaveLength(0);
    await parent.session.prompt("Parent next");
    const request = JSON.stringify(parent.requests[0]);
    expect(request).toContain("parent-work");
    expect(request).not.toContain("child-work");
  });

  it("model messages pass schema validation, persist, and review commands never call the provider or alter model context", async () => {
    const h = await fixture({
      responses: [
        toolCall("todo_upsert", {
          tasks: [
            {
              key: "audit",
              subject: "Audit",
              status: "completed",
              message: "Found 2 issues in token refresh",
            },
          ],
        }),
        fauxAssistantMessage("done"),
      ],
    });
    await h.session.prompt("Work");
    expect(h.errors).toEqual([]);
    expect(h.requests).toHaveLength(2);
    expect(JSON.stringify(h.requests[1])).toContain("lastMessage");
    expect(replayTodoSession({ sessionManager: h.manager }).activity.get("audit")?.updates).toEqual(
      [
        expect.objectContaining({
          revision: 1,
          status: "completed",
          message: "Found 2 issues in token refresh",
        }),
      ],
    );
    await h.session.prompt("/todo:review all");
    expect(h.requests).toHaveLength(2);
    expect(
      h.manager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === TODO_REVIEW_TYPE),
    ).toHaveLength(1);
    const reloaded = await fixture({ manager: h.manager, responses: [fauxAssistantMessage("ok")] });
    const restored = replayTodoSession({ sessionManager: reloaded.manager });
    expect(restored.review.tasks.get("audit")?.revision).toBe(1);
    await reloaded.session.prompt("Next");
    // The direct result is still the current baseline; review added no snapshot.
    expect(JSON.stringify(reloaded.requests[0])).not.toContain("Current task list");
  }, 20_000);

  it("restores exact keys/dependencies after compaction omits task history", async () => {
    const h = await fixture({ responses: [nestedWrite(), fauxAssistantMessage("done")] });
    await h.session.prompt("Work");
    const recentUser = h.manager.appendMessage({
      role: "user",
      content: "Recent",
      timestamp: Date.now(),
    });
    h.manager.appendCompaction("Summary deliberately omits exact plan", recentUser, 1000);
    const restored = await fixture({ manager: h.manager });
    await restored.session.prompt("After compaction");
    expect(snapshot(restored.manager).tasks.map((task) => task.key)).toEqual(["inspect", "verify"]);
    const request = JSON.stringify(restored.requests[0]);
    expect(request).toContain("Current task list (revision 1)");
    expect(request).toContain('\\"dependsOn\\":[\\"inspect\\"]');
    expect(restored.requests).toHaveLength(1);
  }, 20_000);
});
