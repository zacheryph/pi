import { defineAction, defineView, isJsonObject } from "#surface";
import { TODO_SNAPSHOT_EVENT, type TodoSnapshotEvent } from "#todo/events";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import piBb, { type BbDependencies } from "#src/index";
import { CLOSE_UNAUTHORIZED, ENV_THREAD, ENV_TOKEN, ENV_URL, readSurfaceEnv } from "#src/protocol";
import { ENV_BB_SKILLS, ENV_KEEP_ENVIRONMENT_TOOL } from "#src/prompt";
import { FakePlugin } from "#test/fake-plugin";
import { fakePi, sleep } from "#test-helpers";

const SLOT = Symbol.for("bb:surface");

function fakeCtx(mode = "rpc") {
  return {
    mode,
    cwd: "/work/api",
    hasUI: mode !== "print",
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: () => "session-a",
      getBranch: () => [],
      getEntries: () => [],
    },
    model: { provider: "anthropic", id: "claude-opus" },
    getContextUsage: () => ({ tokens: 5000, contextWindow: 200_000, percent: 2.5 }),
    isIdle: () => true,
  };
}

function bbEnv(url: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { [ENV_THREAD]: "thr_test", [ENV_URL]: url, [ENV_TOKEN]: "secret-token", ...overrides };
}

function load(env: NodeJS.ProcessEnv, overrides: Partial<BbDependencies> = {}) {
  const fake = fakePi({ getSessionName: () => "fix-auth", getThinkingLevel: () => "high" });
  piBb(fake.api, { env: () => env, pid: 4242, publishDelayMs: 10, minDelayMs: 20, ...overrides });
  return fake;
}

async function start(fake: ReturnType<typeof load>, ctx = fakeCtx()) {
  onTestFinished(async () => {
    await fake.emit("session_shutdown", { reason: "quit" }, ctx);
  });
  await fake.emit("session_start", { reason: "startup" }, ctx);
  return ctx;
}

const tasks: TodoSnapshotEvent = {
  version: 1,
  revision: 2,
  tasks: [
    {
      key: "fix",
      subject: "Fix the retry loop",
      status: "in_progress",
      blocked: false,
      unreviewed: 0,
      createdAt: 5,
      updates: [{ revision: 2, at: 9, status: "in_progress", from: "pending", message: "on it" }],
    },
  ],
};

describe("pi-bb", () => {
  it("says hello with the thread, token and full snapshot, then sends debounced updates", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    const fake = load(bbEnv(url));
    fake.api.events.emit(TODO_SNAPSHOT_EVENT, tasks);
    const ctx = await start(fake);

    const socket = await plugin.socket();
    expect(plugin.paths[0]).toBe("/api/v1/plugins/pi-surface/http/session");
    const [hello] = await plugin.messages(socket, "hello");
    expect(hello).toMatchObject({
      version: 2,
      threadId: "thr_test",
      token: "secret-token",
      snapshot: {
        id: "4242",
        cwd: "/work/api",
        name: "fix-auth",
        thinking: "high",
        status: { kind: "idle" },
        todos: { total: 1, tasks: [{ key: "fix", status: "in_progress" }] },
      },
    });

    await fake.emit("agent_start", {}, ctx);
    await fake.emit(
      "tool_execution_start",
      { toolCallId: "t1", toolName: "bash", args: { command: "npm test" } },
      ctx,
    );
    await plugin.messages(socket, "update");
    await sleep(50);
    const updates = socket.received.filter(
      (message) => (message as { type?: string }).type === "update",
    );
    // Both events land in one coalesced update.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      snapshot: {
        status: { kind: "tool", tool: "bash" },
        activity: [{ tool: "bash", summary: "npm test", running: true }],
      },
    });
  });

  it("runs the plugin's action requests and sends views in the snapshot", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    const fake = load(bbEnv(url));
    // A stand-in for an extension's explorer and the action that loads its details.
    defineView(fake.api.events, {
      id: "todo.explorer",
      kind: "explorer",
      title: "Todos",
      model: () => ({
        title: "Todos",
        items: [{ id: "fix", label: "fix: Fix the retry loop" }],
        loadDetail: { action: "todo.inspect" },
      }),
    });
    defineAction(fake.api.events, {
      id: "todo.inspect",
      title: "Inspect",
      handler: (args) => {
        const id = isJsonObject(args) && typeof args.id === "string" ? args.id : "";
        if (id !== "fix") throw new Error(`No task "${id}" on this branch.`);
        return [{ heading: id }];
      },
    });
    defineAction(fake.api.events, { id: "todo.noop", title: "Nothing", handler: () => {} });
    await start(fake);
    const socket = await plugin.socket();
    const [hello] = await plugin.messages(socket, "hello");
    expect(hello).toMatchObject({
      version: 2,
      snapshot: {
        views: [
          {
            id: "todo.explorer",
            kind: "explorer",
            title: "Todos",
            model: { items: [{ id: "fix" }], loadDetail: { action: "todo.inspect" } },
          },
        ],
      },
    });

    const request = (id: number, body: Record<string, unknown>) =>
      socket.send({ type: "request", id, request: body });
    request(1, { command: "action", id: "todo.inspect", args: { id: "fix" } });
    request(2, { command: "action", id: "todo.inspect", args: { id: "gone" } });
    request(3, { command: "action", id: "todo.noop" });
    request(4, { command: "action", id: "todo.missing" });
    request(5, { command: "action" });
    request(6, { command: "stash-preview", name: "notes" });
    const results = await plugin.messages(socket, "result", 4);
    const byId = new Map(results.map((result) => [result.id, result]));
    expect(byId.get(1)).toEqual({ type: "result", id: 1, ok: true, data: [{ heading: "fix" }] });
    expect(byId.get(2)).toMatchObject({ ok: false, error: 'No task "gone" on this branch.' });
    expect(byId.get(3)).toEqual({ type: "result", id: 3, ok: true, data: null });
    expect(byId.get(4)).toMatchObject({ ok: false, error: 'Unknown action "todo.missing".' });
    // Malformed and retired requests are dropped, not answered.
    await sleep(50);
    expect(byId.has(5)).toBe(false);
    expect(byId.has(6)).toBe(false);
  });

  it("reconnects after the plugin goes away and says hello again", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    const fake = load(bbEnv(url));
    await start(fake);
    const first = await plugin.socket(0);
    await plugin.messages(first, "hello");
    first.drop();
    const second = await plugin.socket(1);
    const [hello] = await plugin.messages(second, "hello");
    expect(hello).toMatchObject({ threadId: "thr_test", snapshot: { id: "4242" } });
  });

  it("stops retrying when the plugin refuses the token", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    const fake = load(bbEnv(url));
    const ctx = await start(fake);
    const socket = await plugin.socket();
    await plugin.messages(socket, "hello");
    socket.close(CLOSE_UNAUTHORIZED);
    await sleep(200);
    expect(plugin.sockets).toHaveLength(1);
    await fake.command("bb").handler("", ctx);
    expect(fake.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("refused"), display: true }),
      { triggerTurn: false },
    );
  });

  it("says goodbye on shutdown and frees the slot for the next session", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    const fake = load(bbEnv(url));
    const ctx = await start(fake);
    const socket = await plugin.socket();
    await plugin.messages(socket, "hello");
    await fake.emit("session_shutdown", { reason: "reload" }, ctx);
    const [bye] = await plugin.messages(socket, "bye");
    expect(bye).toEqual({ type: "bye", reason: "replace" });
    expect((globalThis as Record<symbol, unknown>)[SLOT]).toBeUndefined();

    // /reload builds a new runtime in the same process; it connects again.
    const next = load(bbEnv(url));
    await start(next);
    await plugin.messages(await plugin.socket(1), "hello");
  });

  it("stays inactive outside RPC mode and without bb's environment", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    const socket = vi.fn();

    await start(load(bbEnv(url), { socket }), fakeCtx("tui"));
    await start(load(bbEnv(url, { [ENV_TOKEN]: "" }), { socket }));
    await start(load(bbEnv(url, { [ENV_THREAD]: undefined }), { socket }));
    await start(load(bbEnv(url, { [ENV_URL]: "file:///nope" }), { socket }));

    await sleep(50);
    expect(socket).not.toHaveBeenCalled();
    expect(plugin.sockets).toHaveLength(0);
    expect((globalThis as Record<symbol, unknown>)[SLOT]).toBeUndefined();
  });

  it("connects once per process: a subagent child's session does not", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    const parent = load(bbEnv(url));
    await start(parent);
    await plugin.messages(await plugin.socket(), "hello");

    // A child session loads the extension again in the same process, with the same environment.
    const child = load(bbEnv(url));
    const childCtx = await start(child);
    await start(load(bbEnv(url)), fakeCtx("print"));
    await sleep(100);
    expect(plugin.sockets).toHaveLength(1);
    await child.command("bb").handler("", childCtx);
    expect(child.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("inactive in this session") }),
      { triggerTurn: false },
    );
    expect(child.shown()).toEqual([
      expect.objectContaining({ customType: "bb:status", display: true, level: "info" }),
    ]);
  });

  it("explains /bb when bb's environment is missing", async () => {
    const fake = load({});
    const ctx = await start(fake, fakeCtx("tui"));
    await fake.command("bb").handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("inactive"), "info");
  });
});

describe("readSurfaceEnv", () => {
  it("turns bb's http endpoint into a WebSocket URL", () => {
    expect(
      readSurfaceEnv({
        [ENV_THREAD]: "thr_1",
        [ENV_TOKEN]: "t",
        [ENV_URL]: "https://bb.example/api/v1/plugins/pi-surface/http/session",
      }),
    ).toEqual({
      threadId: "thr_1",
      token: "t",
      url: "wss://bb.example/api/v1/plugins/pi-surface/http/session",
    });
  });

  describe("bb skills", () => {
    const bb = (name: string) => ({
      name,
      filePath: `/Users/me/.bb/runtime/global-skills/h1/skills/${name}/SKILL.md`,
    });
    const own = (name: string) => ({ name, filePath: `/work/api/skills/${name}/SKILL.md` });
    const skills = () => [
      bb("pi-provider"),
      bb("inline-vis"),
      own("todo"),
      bb("thread-list"),
      own("pi-provider"),
    ];
    async function run(env: NodeJS.ProcessEnv, mode = "rpc") {
      const fake = load(env);
      const options = { skills: skills() };
      await fake.emit("before_agent_start", { systemPromptOptions: options }, fakeCtx(mode));
      return options.skills.map(
        (skill) => `${skill.filePath.includes(".bb") ? "bb" : "own"}:${skill.name}`,
      );
    }

    it("keeps only inline-vis of the skills bb injects, and all of your own", async () => {
      expect(await run({ [ENV_THREAD]: "thr_test" })).toEqual([
        "bb:inline-vis",
        "own:todo",
        "own:pi-provider",
      ]);
    });

    it("takes the allowlist from the environment, and an empty value allows none", async () => {
      expect(
        await run({ [ENV_THREAD]: "thr_test", [ENV_BB_SKILLS]: " thread-list, inline-vis " }),
      ).toEqual(["bb:inline-vis", "own:todo", "bb:thread-list", "own:pi-provider"]);
      expect(await run({ [ENV_THREAD]: "thr_test", [ENV_BB_SKILLS]: "" })).toEqual([
        "own:todo",
        "own:pi-provider",
      ]);
    });

    it("leaves skills alone outside a bb RPC thread", async () => {
      expect(await run({}, "rpc")).toHaveLength(5);
      expect(await run({ [ENV_THREAD]: "thr_test" }, "print")).toHaveLength(5);
    });
  });

  describe("environment tool", () => {
    const text =
      "Keep tests green.\n\nIf the user asks you to move this thread, call `update_environment_directory` with its path.\n\nBe brief.";
    async function run(env: NodeJS.ProcessEnv, mode = "rpc") {
      const fake = load(env);
      const options = {
        selectedTools: ["read", "update_environment_directory", "bash"],
        appendSystemPrompt: text,
      };
      await fake.emit("before_agent_start", { systemPromptOptions: options }, fakeCtx(mode));
      return options;
    }

    it("removes the tool and its instruction in a bb thread, keeping other text", async () => {
      const options = await run({ [ENV_THREAD]: "thr_test" });
      expect(options.selectedTools).toEqual(["read", "bash"]);
      expect(options.appendSystemPrompt).toBe("Keep tests green.\n\nBe brief.");
    });

    it("keeps both when PI_BB_ENVIRONMENT_TOOL=1, and outside a bb RPC thread", async () => {
      for (const options of [
        await run({ [ENV_THREAD]: "thr_test", [ENV_KEEP_ENVIRONMENT_TOOL]: "1" }),
        await run({}),
        await run({ [ENV_THREAD]: "thr_test" }, "print"),
      ]) {
        expect(options.selectedTools).toHaveLength(3);
        expect(options.appendSystemPrompt).toBe(text);
      }
    });
  });
});
