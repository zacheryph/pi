import {
  defineAction,
  defineView,
  hasFormConsumer,
  isJsonObject,
  listFormConsumers,
  SESSION_VIEW_ID,
  type SessionModel,
  type SummaryModel,
} from "#surface";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import piBb, { type BbDependencies } from "#src/index";
import {
  CLOSE_UNAUTHORIZED,
  CLOSE_UNSUPPORTED,
  ENV_THREAD,
  ENV_TOKEN,
  ENV_URL,
  readSurfaceEnv,
} from "#src/protocol";
import { ENV_BB_SKILLS, ENV_KEEP_ENVIRONMENT_TOOL } from "#src/prompt";
import { FakePlugin, type FakeSocket } from "#test/fake-plugin";
import { fakePi, sleep, waitFor } from "#test-helpers";

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
    isIdle: () => true,
  };
}

function bbEnv(url: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { [ENV_THREAD]: "thr_test", [ENV_URL]: url, [ENV_TOKEN]: "secret-token", ...overrides };
}

function load(env: NodeJS.ProcessEnv, overrides: Partial<BbDependencies> = {}) {
  const fake = fakePi();
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

const session = (status: SessionModel["status"]): SessionModel => ({
  sessionId: "session-a",
  cwd: "/work/api",
  name: "fix-auth",
  thinking: "high",
  status,
  startedAt: 1,
});

/** pi-system-insights' view, as a stand-in: pi-bb only collects it. */
function sessionView(fake: ReturnType<typeof load>, model: () => SessionModel) {
  return defineView(fake.api.events, {
    id: SESSION_VIEW_ID,
    kind: "session",
    title: "Session",
    model,
  });
}

/** Tell consumers a view changed, as its producer would. */
function announce(fake: ReturnType<typeof load>, id: string) {
  fake.api.events.emit("surface:view-changed", { version: 1, id });
}

/** Snapshot messages on a socket: hellos and updates, in order. */
function snapshots(socket: FakeSocket) {
  return socket.received.filter((message) =>
    ["hello", "update"].includes((message as { type?: string }).type ?? ""),
  ) as Array<Record<string, any>>;
}

/** The nth socket once it said hello, welcomed as the plugin does after checking the token. */
async function connected(plugin: FakePlugin, index = 0) {
  const socket = await plugin.socket(index);
  const [hello] = await plugin.messages(socket, "hello");
  socket.welcome();
  return { socket, hello: hello! };
}

const consumers = (fake: ReturnType<typeof load>) => listFormConsumers(fake.api.events).length;

describe("pi-bb", () => {
  it("says hello with the thread, token and every view, then sends one update per burst once welcomed", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    const fake = load(bbEnv(url));
    let status: SessionModel["status"] = { kind: "idle", since: 1 };
    sessionView(fake, () => session(status));
    const counts: SummaryModel = { counts: [{ key: "total", label: "task", value: 1 }] };
    defineView(fake.api.events, {
      id: "todo.summary",
      kind: "summary",
      title: "Tasks",
      model: () => counts,
    });
    await start(fake);

    const socket = await plugin.socket();
    expect(plugin.paths[0]).toBe("/api/v1/plugins/pi-surface/http/session");
    const [hello] = await plugin.messages(socket, "hello");
    expect(hello).toEqual({
      type: "hello",
      version: 3,
      threadId: "thr_test",
      token: "secret-token",
      snapshot: {
        id: "4242",
        host: { pid: 4242 },
        views: [
          { id: SESSION_VIEW_ID, kind: "session", title: "Session", model: session(status) },
          { id: "todo.summary", kind: "summary", title: "Tasks", model: counts },
        ],
      },
    });

    // Not welcomed yet: changes wait for the plugin to accept the session.
    status = { kind: "working", since: 2 };
    announce(fake, SESSION_VIEW_ID);
    await sleep(50);
    expect(snapshots(socket)).toHaveLength(1);
    socket.welcome();
    const [update] = await plugin.messages(socket, "update");
    expect(update!.snapshot.views[0].model.status).toEqual({ kind: "working", since: 2 });

    // A burst of announcements is one update with the state after the burst.
    status = { kind: "tool", tool: "bash", since: 3 };
    for (let index = 0; index < 5; index++) announce(fake, SESSION_VIEW_ID);
    await plugin.messages(socket, "update", 2);
    await sleep(50);
    expect(snapshots(socket)).toHaveLength(3);
    expect(snapshots(socket)[2]!.snapshot.views[0].model.status.kind).toBe("tool");
  });

  it("sends a snapshot without a system view, and drops a view that is removed", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    const fake = load(bbEnv(url));
    const remove = defineView(fake.api.events, {
      id: "todo.summary",
      kind: "summary",
      title: "Tasks",
      model: () => ({ counts: [] }),
    });
    defineView(fake.api.events, {
      id: "stash.summary",
      kind: "summary",
      title: "Stash",
      model: () => {
        throw new Error("index unreadable");
      },
    });
    await start(fake);
    const { hello, socket } = await connected(plugin);
    expect(hello.snapshot.views).toEqual([
      { id: "stash.summary", kind: "summary", title: "Stash", error: "index unreadable" },
      { id: "todo.summary", kind: "summary", title: "Tasks", model: { counts: [] } },
    ]);
    remove();
    const [update] = await plugin.messages(socket, "update");
    expect(update!.snapshot.views.map((view: { id: string }) => view.id)).toEqual([
      "stash.summary",
    ]);
  });

  it("does not observe Pi's core events itself", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    const fake = load(bbEnv(url));
    const ctx = await start(fake);
    const { socket } = await connected(plugin);
    await fake.emit("agent_start", {}, ctx);
    await fake.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: {} }, ctx);
    await fake.emit("tool_execution_end", { toolCallId: "t1", toolName: "bash" }, ctx);
    await sleep(50);
    expect(snapshots(socket)).toHaveLength(1);
  });

  it("fits a snapshot into the plugin's message limit in UTF-8 bytes", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    // 400 UTF-16 units each, but the multibyte view is 1,200 bytes of UTF-8.
    const fake = load(bbEnv(url), { maxMessageBytes: 1_400 });
    const view = (id: string, text: string) =>
      defineView(fake.api.events, {
        id,
        kind: "detail",
        title: id,
        model: () => ({ title: id, content: text }),
      });
    view("wide.notes", "€".repeat(400));
    view("plain.notes", "a".repeat(400));
    const ctx = await start(fake);
    const { hello, socket } = await connected(plugin);
    expect(new TextEncoder().encode(JSON.stringify(hello)).length).toBeLessThanOrEqual(1_400);
    expect(hello.snapshot.views).toEqual([
      expect.objectContaining({ id: "plain.notes", model: expect.any(Object) }),
      expect.objectContaining({ id: "wide.notes", error: expect.stringContaining("Left out") }),
    ]);
    await fake.command("bb").handler("", ctx);
    expect(fake.pi.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: expect.stringContaining("left out wide.notes") }),
      { triggerTurn: false },
    );
    expect(snapshots(socket)).toHaveLength(1);
  });

  it("sends nothing and says why when even a snapshot of errors cannot fit", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    const fake = load(bbEnv(url), { maxMessageBytes: 200 });
    for (const id of ["a.one", "b.two", "c.three", "d.four"])
      defineView(fake.api.events, {
        id,
        kind: "detail",
        title: id,
        model: () => ({ title: id, content: "x" }),
      });
    const ctx = await start(fake);
    await plugin.socket();
    await sleep(80);
    // No hello carries a cut snapshot.
    expect(plugin.sockets.flatMap((socket) => snapshots(socket))).toEqual([]);
    await fake.command("bb").handler("", ctx);
    expect(fake.pi.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: expect.stringContaining("does not fit one message") }),
      { triggerTurn: false },
    );
  });

  it("runs the plugin's action requests and answers only the socket that asked", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    const fake = load(bbEnv(url));
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
    defineAction(fake.api.events, {
      id: "todo.verbose",
      title: "Fails at length",
      handler: () => {
        throw new Error("x".repeat(2_000));
      },
    });
    let release: (() => void) | undefined;
    defineAction(fake.api.events, {
      id: "todo.slow",
      title: "Slow",
      handler: () => new Promise<string>((resolve) => (release = () => resolve("late"))),
    });
    await start(fake);
    const { socket } = await connected(plugin);
    const request = (id: number, body: unknown, target = socket) =>
      target.send({ type: "request", id, request: body });
    request(1, { action: "todo.inspect", args: { id: "fix" } });
    request(2, { action: "todo.inspect", args: { id: "gone" } });
    request(3, { action: "todo.noop" });
    request(4, { action: "todo.missing" });
    request(5, { action: "todo.verbose" });
    request(6, { action: "Not An Id" });
    request(7, { command: "action", id: "todo.noop" });
    request(8, { action: "todo.noop", extra: true });
    const results = await plugin.messages(socket, "result", 5);
    const byId = new Map(results.map((result) => [result.id, result]));
    expect(byId.get(1)).toEqual({ type: "result", id: 1, ok: true, value: [{ heading: "fix" }] });
    expect(byId.get(2)).toEqual({
      type: "result",
      id: 2,
      ok: false,
      error: 'No task "gone" on this branch.',
    });
    expect(byId.get(3)).toEqual({ type: "result", id: 3, ok: true });
    expect(byId.get(4)).toMatchObject({ ok: false, error: 'Unknown action "todo.missing".' });
    expect(byId.get(5)!.error).toHaveLength(500);
    // Malformed and retired requests are dropped, not answered.
    await sleep(50);
    for (const id of [6, 7, 8]) expect(byId.has(id)).toBe(false);

    // A request still running when its socket goes is never answered on the next one.
    request(9, { action: "todo.slow" });
    await waitFor(() => release);
    socket.drop();
    const next = await connected(plugin, 1);
    release!();
    await sleep(50);
    const types = next.socket.received.map((message) => (message as { type: string }).type);
    expect(types).not.toContain("result");
  });

  it("does not answer requests before the plugin welcomes the session", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    const fake = load(bbEnv(url));
    defineAction(fake.api.events, { id: "todo.noop", title: "Nothing", handler: () => {} });
    await start(fake);
    const socket = await plugin.socket();
    await plugin.messages(socket, "hello");
    socket.send({ type: "request", id: 1, request: { action: "todo.noop" } });
    await sleep(50);
    expect(socket.received.map((message) => (message as { type: string }).type)).toEqual(["hello"]);
  });

  it("advertises itself as a form consumer only while the plugin has welcomed it", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    const fake = load(bbEnv(url));
    const bus = fake.api.events;
    await start(fake);
    const first = await plugin.socket(0);
    await plugin.messages(first, "hello");
    expect(hasFormConsumer(bus)).toBe(false);
    first.welcome();
    await waitFor(() => hasFormConsumer(bus) || undefined);
    expect(listFormConsumers(bus)).toEqual([{ name: "bb" }]);

    // The connection drops: capability goes with it, and returns with the next welcome.
    first.drop();
    await waitFor(() => !hasFormConsumer(bus) || undefined);
    const second = await plugin.socket(1);
    await plugin.messages(second, "hello");
    expect(hasFormConsumer(bus)).toBe(false);
    second.welcome();
    await waitFor(() => hasFormConsumer(bus) || undefined);
    // A repeated welcome on the same socket is not a second consumer.
    second.welcome();
    await sleep(20);
    expect(consumers(fake)).toBe(1);

    // Refused (a newer process for the thread took over): no capability and no retry.
    second.close(4409);
    await waitFor(() => !hasFormConsumer(bus) || undefined);
    await sleep(100);
    expect(plugin.sockets).toHaveLength(2);
  });

  it("withdraws its form capability on shutdown", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    const fake = load(bbEnv(url));
    const ctx = await start(fake);
    await connected(plugin);
    await waitFor(() => hasFormConsumer(fake.api.events) || undefined);
    await fake.emit("session_shutdown", { reason: "new" }, ctx);
    expect(hasFormConsumer(fake.api.events)).toBe(false);
  });

  it("reconnects after the plugin goes away and says hello again", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    const fake = load(bbEnv(url));
    let name = "before";
    sessionView(fake, () => ({ ...session({ kind: "idle", since: 1 }), name }));
    await start(fake);
    const first = await connected(plugin, 0);
    expect(first.hello.snapshot.views[0].model.name).toBe("before");
    name = "after";
    announce(fake, SESSION_VIEW_ID);
    await plugin.messages(first.socket, "update");
    first.socket.drop();
    const [hello] = await plugin.messages(await plugin.socket(1), "hello");
    expect(hello).toMatchObject({ threadId: "thr_test", snapshot: { id: "4242" } });
    expect(hello!.snapshot.views[0].model.name).toBe("after");
  });

  it("stops retrying when the plugin refuses the token, and says why", async () => {
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

  it("refuses a plugin of another protocol version with the reinstall advice", async () => {
    const refusals: Array<(socket: FakeSocket) => void> = [
      (socket) => socket.close(CLOSE_UNSUPPORTED),
      // A plugin that welcomes another version cannot read this session's snapshots either.
      (socket) => socket.welcome(2),
    ];
    for (const refuse of refusals) {
      const plugin = new FakePlugin();
      const url = await plugin.start();
      const fake = load(bbEnv(url));
      const ctx = await start(fake);
      const socket = await plugin.socket();
      await plugin.messages(socket, "hello");
      refuse(socket);
      await sleep(150);
      expect(plugin.sockets).toHaveLength(1);
      expect(hasFormConsumer(fake.api.events)).toBe(false);
      await fake.command("bb").handler("", ctx);
      expect(fake.pi.sendMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          content: expect.stringMatching(/refused this session \(4400.*reinstalling the plugin/),
        }),
        { triggerTurn: false },
      );
      await fake.emit("session_shutdown", { reason: "quit" }, ctx);
    }
  });

  it("says goodbye on shutdown and frees the slot for the next session", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    const fake = load(bbEnv(url));
    const ctx = await start(fake);
    const { socket } = await connected(plugin);
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
