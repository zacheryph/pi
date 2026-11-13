import { STASH_PREVIEW_REQUEST, type StashPreviewRequest } from "#stash/events";
import { TODO_SNAPSHOT_EVENT, type TodoSnapshotEvent } from "#todo/events";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import piBb, { type BbDependencies } from "#src/index";
import { CLOSE_UNAUTHORIZED, ENV_THREAD, ENV_TOKEN, ENV_URL, readSurfaceEnv } from "#src/protocol";
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
      version: 1,
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

  it("answers the plugin's requests through the presentation service", async () => {
    const plugin = new FakePlugin();
    const url = await plugin.start();
    const fake = load(bbEnv(url));
    fake.api.events.on(STASH_PREVIEW_REQUEST, (data) => {
      const request = data as StashPreviewRequest;
      request.respond(
        request.name === "notes"
          ? { ok: true, handle: "stash:notes@0123", lines: ["first"], total: 1, complete: true }
          : { ok: false, error: `No stash entry named "${request.name}" on this branch.` },
      );
    });
    fake.api.events.emit(TODO_SNAPSHOT_EVENT, tasks);
    await start(fake);
    const socket = await plugin.socket();
    await plugin.messages(socket, "hello");

    socket.send({ type: "request", id: 1, request: { command: "stash-preview", name: "notes" } });
    socket.send({ type: "request", id: 2, request: { command: "stash-preview", name: "gone" } });
    socket.send({ type: "request", id: 3, request: { command: "todo-history", key: "fix" } });
    socket.send({ type: "request", id: 4, request: { command: "focus" } });
    const results = await plugin.messages(socket, "result", 3);
    const byId = new Map(results.map((result) => [result.id, result]));
    expect(byId.get(1)).toEqual({
      type: "result",
      id: 1,
      ok: true,
      data: { handle: "stash:notes@0123", lines: ["first"], total: 1, complete: true },
    });
    expect(byId.get(2)).toMatchObject({ ok: false, error: expect.stringContaining("gone") });
    expect(byId.get(3)).toMatchObject({
      ok: true,
      data: { key: "fix", updates: [{ status: "in_progress", message: "on it" }] },
    });
    // Unknown requests are dropped, not answered.
    await sleep(50);
    expect(byId.has(4)).toBe(false);
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
    );
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
});
