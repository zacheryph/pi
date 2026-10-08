import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import todoExtension from "#src/index";
import { loadTodoConfig } from "#src/config";
import { replayTodoState } from "#src/state";
import { replayTaskState, TODO_JOURNAL_TYPE } from "#src/replay";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function fixture(options: {
  manager?: SessionManager;
  responses?: ReturnType<typeof fauxAssistantMessage>[];
  delayToolResult?: () => Promise<void>;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-sdk-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const faux = createFauxCore({ provider: "todo-test", models: [{ id: "test" }] });
  const calls = vi.fn(faux.streamSimple);
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "cache"), refreshOnCreate: false });
  modelRuntime.registerProvider("todo-test", { api: faux.api, apiKey: "test-key", models: faux.models, streamSimple: calls });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory({}),
    noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      pi => todoExtension(pi, { loadConfig: cwd => loadTodoConfig(cwd, dir) }),
      createCodemodeExtension(),
      pi => {
        if (options.delayToolResult) pi.on("tool_result", async event => {
          if (event.toolName === "todo") await options.delayToolResult!();
        });
      },
    ],
  });
  await loader.reload();
  const manager = options.manager ?? SessionManager.inMemory(dir);
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel(), resourceLoader: loader,
    sessionManager: manager, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    tools: ["todo", "codemode"],
  });
  cleanups.push(() => session.dispose());
  const errors = vi.fn();
  await session.bindExtensions({ mode: "print", onError: errors });
  faux.setResponses(options.responses ?? [fauxAssistantMessage("done")]);
  return { session, manager, faux, calls, errors };
}

const nestedWrite = (after = 'return "hidden";') => fauxAssistantMessage(fauxToolCall("codemode", {
  code: `await tools.todo({action:"upsert",tasks:[{key:"inspect",subject:"Inspect",status:"in_progress"},{key:"verify",subject:"Verify",dependsOn:["inspect"]}]}); ${after}`,
}), { stopReason: "toolUse" });

function snapshot(manager: SessionManager) {
  return replayTaskState({ sessionManager: manager });
}

describe("real Pi SDK integration (offline faux provider)", () => {
  it("loads standalone package with exactly one tool and expected commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-todo-loader-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir,
      settingsManager: SettingsManager.inMemory({ packages: [resolve(import.meta.dirname, "..")] }),
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const { extensions, errors } = loader.getExtensions();
    expect(errors).toEqual([]);
    expect(extensions).toHaveLength(1);
    expect([...extensions[0].tools.keys()]).toEqual(["todo"]);
    expect([...extensions[0].commands.keys()]).toEqual([
      "todos", "todos:list", "todos:add", "todos:update", "todos:remove", "todos:clear", "todos:settings",
    ]);
  });

  it.each([['suppressed result', 'return "hidden";'], ['later script failure', 'throw new Error("after write");']] as const)(
    "journals nested mutation with %s, replays through fresh loader", async (_label, after) => {
      const h = await fixture({ responses: [nestedWrite(after), fauxAssistantMessage("done")] });
      await h.session.prompt("Work");
      expect(h.calls).toHaveBeenCalledTimes(2);
      expect(h.errors).not.toHaveBeenCalled();
      const branch = h.manager.getBranch();
      expect(branch.filter(entry => entry.type === "custom" && entry.customType === TODO_JOURNAL_TYPE)).toHaveLength(1);
      expect(branch.filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo")).toHaveLength(0);
      expect(snapshot(h.manager).tasks.map(task => task.key)).toEqual(["inspect", "verify"]);
      const nextRequest = JSON.stringify(h.calls.mock.calls[1][1]);
      expect(nextRequest).toContain("Current task list (revision 1)");
      expect(nextRequest).toContain('\\"dependsOn\\":[\\"inspect\\"]');
      const reloaded = await fixture({ manager: h.manager });
      await reloaded.session.prompt("Resume");
      expect(JSON.stringify(reloaded.calls.mock.calls[0][1])).toContain("Current task list (revision 1)");
      expect(snapshot(reloaded.manager).tasks).toEqual(snapshot(h.manager).tasks);
    }, 20_000,
  );

  it("commands never call provider; next ordinary request sees exact changed/empty plan", async () => {
    const h = await fixture();
    await h.session.prompt("/todos:add Fix auth");
    expect(h.calls).not.toHaveBeenCalled();
    expect(snapshot(h.manager).tasks[0]).toMatchObject({ key: "fix-auth", status: "pending" });
    await h.session.prompt("Continue");
    expect(h.calls).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.calls.mock.calls[0][1])).toContain("Current task list (revision 1)");
    h.faux.setResponses([fauxAssistantMessage("still tracked")]);
    await h.session.prompt("Another request without direct todo results");
    expect(h.calls).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.calls.mock.calls[1][1])).toContain("Current task list (revision 1)");
    await h.session.prompt("/todos:clear all --yes");
    expect(h.calls).toHaveBeenCalledTimes(2);
    h.faux.setResponses([fauxAssistantMessage("done again")]);
    await h.session.prompt("Next");
    expect(h.calls).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(h.calls.mock.calls[2][1])).toContain("Current task list (revision 2)");
    expect(snapshot(h.manager).tasks).toEqual([]);
  });

  it("delayed direct results cannot overwrite a newer command journal on reload", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const h = await fixture({
      responses: [
        fauxAssistantMessage(fauxToolCall("todo", { action: "upsert", tasks: [{ key: "old", subject: "Old" }] }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ],
      delayToolResult: async () => { entered(); await gate; },
    });
    const running = h.session.prompt("Work");
    await ready;
    await h.session.prompt("/todos:clear all --yes");
    expect(snapshot(h.manager).revision).toBe(2);
    release();
    await running;
    // Upstream tool-result-only replay would restore the late revision-one task.
    expect(replayTodoState({ sessionManager: h.manager }).tasks).toHaveLength(1);
    expect(snapshot(h.manager).tasks).toEqual([]);
    const restored = await fixture({ manager: h.manager });
    await restored.session.prompt("After reload");
    expect(snapshot(restored.manager).tasks).toEqual([]);
    expect(JSON.stringify(restored.calls.mock.calls[0][1])).toContain("Current task list (revision 2)");
  }, 20_000);

  it("real tree navigation restores branch-local state instead of abandoned additions", async () => {
    const h = await fixture();
    await h.session.prompt("/todos:add First work");
    const first = h.manager.getLeafId()!;
    await h.session.prompt("/todos:add Abandoned work");
    expect(snapshot(h.manager).tasks).toHaveLength(2);
    await h.session.navigateTree(first, { summarize: false });
    await h.session.prompt("Current branch");
    expect(snapshot(h.manager).tasks.map(task => task.key)).toEqual(["first-work"]);
    const request = JSON.stringify(h.calls.mock.calls[0][1]);
    expect(request).toContain("first-work");
    expect(request).not.toContain("abandoned-work");
  });

  it("direct todo results provide persistent baseline, avoiding duplicate context snapshots", async () => {
    const h = await fixture({ responses: [
      fauxAssistantMessage(fauxToolCall("todo", { action: "upsert", tasks: [{ key: "tracked", subject: "Tracked" }] }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ] });
    await h.session.prompt("Work");
    const secondRequest = JSON.stringify(h.calls.mock.calls[1][1]);
    expect(secondRequest).toContain("tracked");
    expect(secondRequest).not.toContain("Current task list");
    h.faux.setResponses([fauxAssistantMessage("done again")]);
    await h.session.prompt("Still tracked");
    expect(JSON.stringify(h.calls.mock.calls[2][1])).not.toContain("Current task list");
    expect(snapshot(h.manager).tasks.map(task => task.key)).toEqual(["tracked"]);
  });

  it("same-process independent loaders keep parent/child plans and checkpoints isolated", async () => {
    const parent = await fixture();
    const child = await fixture();
    await parent.session.prompt("/todos:add Parent work");
    await child.session.prompt("/todos:add Child work");
    await child.session.prompt("/todos:update child-work completed");
    expect(snapshot(parent.manager).tasks).toEqual([expect.objectContaining({ key: "parent-work", status: "pending" })]);
    expect(snapshot(child.manager).tasks).toEqual([expect.objectContaining({ key: "child-work", status: "completed" })]);
    expect(parent.calls).not.toHaveBeenCalled();
    expect(child.calls).not.toHaveBeenCalled();
    await parent.session.prompt("Parent next");
    const request = JSON.stringify(parent.calls.mock.calls[0][1]);
    expect(request).toContain("parent-work");
    expect(request).not.toContain("child-work");
  });

  it("restores exact keys/dependencies after compaction omits task history", async () => {
    const h = await fixture({ responses: [nestedWrite(), fauxAssistantMessage("done")] });
    await h.session.prompt("Work");
    const recentUser = h.manager.appendMessage({ role: "user", content: "Recent", timestamp: Date.now() });
    h.manager.appendCompaction("Summary deliberately omits exact plan", recentUser, 1000);
    const restored = await fixture({ manager: h.manager });
    await restored.session.prompt("After compaction");
    expect(snapshot(restored.manager).tasks.map(task => task.key)).toEqual(["inspect", "verify"]);
    const request = JSON.stringify(restored.calls.mock.calls[0][1]);
    expect(request).toContain("Current task list (revision 1)");
    expect(request).toContain('\\"dependsOn\\":[\\"inspect\\"]');
    expect(restored.calls).toHaveBeenCalledTimes(1);
  }, 20_000);
});
