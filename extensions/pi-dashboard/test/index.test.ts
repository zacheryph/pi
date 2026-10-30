import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { Hub } from "#src/hub/hub";
import dashboardExtension, { type DashboardDependencies } from "#src/index";
import { get, onCleanup, tempDir, waitFor } from "#test/helpers";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  let name: string | undefined = "fix-auth";
  const pi = {
    on: (event: string, handler: Handler) => { handlers.set(event, [...handlers.get(event) ?? [], handler]); return () => {}; },
    registerCommand: (command: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(command, options),
    getSessionName: () => name,
    getThinkingLevel: () => "high",
    exec: vi.fn(),
  } as unknown as ExtensionAPI;
  const emit = async (event: string, payload: Record<string, unknown>, ctx: unknown) => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
  };
  return { pi, emit, commands, rename: (next: string) => { name = next; } };
}

function fakeCtx(mode = "tui") {
  return {
    mode, cwd: "/work/api", hasUI: mode !== "print", ui: { notify: vi.fn() },
    sessionManager: { getSessionId: () => "session-a", getBranch: () => [] },
    model: { provider: "anthropic", id: "claude-opus" },
    getContextUsage: () => ({ tokens: 5000, contextWindow: 200_000, percent: 2.5 }),
    isIdle: () => true,
  };
}

function setup(overrides: Partial<DashboardDependencies> = {}) {
  const dir = tempDir();
  const hubs: Hub[] = [];
  onCleanup(() => Promise.all(hubs.map((hub) => hub.stop())));
  const spawnHub = vi.fn(() => {
    const hub = new Hub({ dir, port: 0, idleGraceMs: 300 });
    hubs.push(hub);
    void hub.start();
  });
  const deps: DashboardDependencies = { dir, spawnHub, publishDelayMs: 10, loadConfig: () => ({ port: 7317 }), ...overrides };
  const sessions = async () => {
    const hub = hubs.at(-1);
    return hub?.httpPort ? JSON.parse((await get(hub.httpPort, "/api/sessions")).body).sessions as Array<Record<string, unknown>> : [];
  };
  return { deps, spawnHub, sessions, hubs };
}

function load(deps: DashboardDependencies, pid = 4242) {
  const fake = fakePi();
  dashboardExtension(fake.pi, { ...deps, pid });
  return fake;
}

async function quit(fake: ReturnType<typeof fakePi>, ctx: unknown) {
  await fake.emit("session_shutdown", { reason: "quit" }, ctx);
}

describe("pi-dashboard extension", () => {
  it("reports an interactive session and follows its status", async () => {
    const env = setup();
    const fake = load(env.deps);
    const ctx = fakeCtx();
    onCleanup(() => quit(fake, ctx));
    await fake.emit("session_start", { reason: "startup" }, ctx);
    const [card] = await waitFor(async () => { const list = await env.sessions(); return list.length ? list : undefined; });
    expect(card).toMatchObject({
      id: "4242", pid: 4242, cwd: "/work/api", name: "fix-auth", thinking: "high",
      model: { provider: "anthropic", id: "claude-opus" }, status: { kind: "idle" },
      context: { tokens: 5000, window: 200_000, percent: 2.5 },
    });

    await fake.emit("agent_start", {}, ctx);
    await fake.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: {} }, ctx);
    await fake.emit("tool_execution_start", { toolCallId: "t1/1", toolName: "read", args: {}, parentToolCallId: "t1" }, ctx);
    await waitFor(async () => ((await env.sessions())[0]?.status as { tool?: string })?.tool === "bash");

    fake.rename("renamed");
    await fake.emit("session_info_changed", { name: "renamed" }, ctx);
    await fake.emit("agent_settled", {}, ctx);
    await waitFor(async () => {
      const [current] = await env.sessions();
      return current?.name === "renamed" && (current.status as { kind: string }).kind === "idle";
    });
  });

  it("does not report print-mode runs", async () => {
    const env = setup();
    const fake = load(env.deps);
    await fake.emit("session_start", { reason: "startup" }, fakeCtx("print"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(env.spawnHub).not.toHaveBeenCalled();
  });

  it("reports one session per process, and frees the slot when it quits", async () => {
    const env = setup();
    const main = load(env.deps, 1);
    const embedded = load(env.deps, 2);
    const mainCtx = fakeCtx();
    const embeddedCtx = fakeCtx();
    onCleanup(() => quit(embedded, embeddedCtx));
    await main.emit("session_start", { reason: "startup" }, mainCtx);
    await embedded.emit("session_start", { reason: "startup" }, embeddedCtx);
    await waitFor(async () => (await env.sessions()).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await env.sessions()).map((card) => card.id)).toEqual(["1"]);

    await quit(main, mainCtx);
    await waitFor(async () => (await env.sessions()).length === 0);
    await embedded.emit("session_start", { reason: "startup" }, embeddedCtx);
    await waitFor(async () => (await env.sessions())[0]?.id === "2");
  });

  it("keeps the card through a reload and picks it up from the new runtime", async () => {
    const env = setup();
    const before = load(env.deps);
    const ctx = fakeCtx();
    await before.emit("session_start", { reason: "startup" }, ctx);
    await waitFor(async () => (await env.sessions()).length === 1);
    await before.emit("session_shutdown", { reason: "reload" }, ctx);
    await waitFor(async () => (await env.sessions())[0]?.restarting === true);

    const after = load(env.deps);
    onCleanup(() => quit(after, ctx));
    after.rename("reloaded");
    await after.emit("session_start", { reason: "reload" }, ctx);
    await waitFor(async () => {
      const [card] = await env.sessions();
      return card?.name === "reloaded" && card.restarting === undefined;
    });
    expect(env.spawnHub).toHaveBeenCalledTimes(1);
  });

  it("/dashboard opens the URL when the hub answers", async () => {
    const env = setup();
    const openUrl = vi.fn(async () => {});
    const fake = load({ ...env.deps, openUrl, isHubReachable: async () => true });
    const ctx = fakeCtx();
    await fake.commands.get("dashboard")!.handler("", ctx);
    expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:7317/");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Dashboard: http://127.0.0.1:7317/", "info");
  });

  it("/dashboard explains when no hub is running", async () => {
    const env = setup();
    const openUrl = vi.fn(async () => {});
    const fake = load({ ...env.deps, openUrl, isHubReachable: async () => false });
    const ctx = fakeCtx("print");
    await fake.commands.get("dashboard")!.handler("", ctx);
    expect(openUrl).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not running"), "warning");
  });
});
