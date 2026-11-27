import {
  announceView,
  defineAction,
  defineView,
  FORM_VIEW_ID,
  hasFormConsumer,
  isJsonObject,
  SESSION_VIEW_ID,
  type FormQuestionnaire,
  type SessionModel,
} from "#surface";
import { describe, expect, it, vi } from "vitest";
import { Hub } from "#src/hub/hub";
import dashboardExtension, { type DashboardDependencies } from "#src/index";
import {
  core,
  listSessions,
  onCleanup,
  post,
  postAction,
  sessionModel,
  sleep,
  tempDir,
  view,
  waitFor,
} from "#test/helpers";
import { fakePi } from "#test-helpers";

function fakeCtx(mode = "tui") {
  return { mode, cwd: "/work/api", hasUI: mode !== "print", ui: { notify: vi.fn() } };
}

function setup(overrides: Partial<DashboardDependencies> = {}) {
  const dir = tempDir();
  const hubs: Hub[] = [];
  onCleanup(() => Promise.all(hubs.map((hub) => hub.stop())));
  const spawnHub = vi.fn(() => {
    // Reporter reconnect starts after 250 ms; a 300 ms hub lifetime raced slow CI.
    // These integration tests stop hubs explicitly and do not exercise idle expiry.
    const hub = new Hub({ dir, port: 0, idleGraceMs: 5_000 });
    hubs.push(hub);
    void hub.start();
  });
  const deps: DashboardDependencies = {
    dir,
    spawnHub,
    publishDelayMs: 10,
    loadConfig: () => ({ port: 7317 }),
    detectTerminal: () => undefined,
    ...overrides,
  };
  const sessions = () => listSessions(hubs.at(-1));
  const hub = () => hubs.at(-1)!;
  const focus = async (id: string) =>
    post(hub().httpPort!, `/api/sessions/${id}/focus`, { "x-dashboard-token": hub().token });
  const first = () =>
    waitFor(async () => {
      const list = await sessions();
      return list.length ? list[0] : undefined;
    });
  return { deps, spawnHub, sessions, hubs, hub, focus, first };
}

function load(deps: DashboardDependencies, pid = 4242) {
  const fake = fakePi({ exec: vi.fn() });
  dashboardExtension(fake.api, { ...deps, pid });
  return fake;
}

type Fake = ReturnType<typeof load>;

async function quit(fake: Fake, ctx: unknown) {
  await fake.emit("session_shutdown", { reason: "quit" }, ctx);
}

/** Stand-in for pi-system-insights' `system.session` view, with a model the test changes. */
function systemView(fake: Fake, initial: Partial<SessionModel> = {}) {
  let model = sessionModel(initial);
  const remove = defineView(fake.api.events, {
    id: SESSION_VIEW_ID,
    kind: "session",
    title: "Session",
    model: () => model,
  });
  return {
    set(next: Partial<SessionModel>) {
      model = { ...model, ...next };
      announceView(fake.api.events, SESSION_VIEW_ID);
    },
    remove,
  };
}

describe("pi-dashboard extension", () => {
  it("reports the session's collected views and follows their changes", async () => {
    const env = setup();
    const fake = load(env.deps);
    const ctx = fakeCtx();
    onCleanup(() => quit(fake, ctx));
    // Extensions that load first define their views before the dashboard starts.
    const system = systemView(fake, { name: "fix-auth" });
    await fake.emit("session_start", { reason: "startup" }, ctx);
    const card = await env.first();
    expect(card).toEqual({
      id: "4242",
      host: { pid: 4242 },
      views: [
        {
          id: SESSION_VIEW_ID,
          kind: "session",
          title: "Session",
          model: sessionModel({ name: "fix-auth" }),
        },
      ],
    });
    system.set({ name: "renamed", status: { kind: "tool", tool: "bash", since: 9 } });
    await waitFor(async () => core((await env.sessions())[0])?.name === "renamed");
    expect(core((await env.sessions())[0])?.status).toEqual({
      kind: "tool",
      tool: "bash",
      since: 9,
    });

    // A view defined after start arrives, and one removed disappears from the next snapshot.
    const removeSummary = defineView(fake.api.events, {
      id: "todo.summary",
      kind: "summary",
      title: "Tasks",
      model: () => ({ counts: [{ key: "total", label: "tasks", value: 3 }] }),
    });
    await waitFor(async () => view((await env.sessions())[0], "todo.summary") !== undefined);
    removeSummary();
    await waitFor(async () => view((await env.sessions())[0], "todo.summary") === undefined);
    expect(core((await env.sessions())[0])?.name).toBe("renamed");
  });

  it("keeps other views and Focus without a system view, and shows a failed one as an error", async () => {
    const adapter = { info: { kind: "cmux", label: "cmux" }, focus: vi.fn(async () => {}) };
    const env = setup({ detectTerminal: () => adapter });
    const fake = load(env.deps);
    const ctx = fakeCtx();
    onCleanup(() => quit(fake, ctx));
    defineView(fake.api.events, {
      id: "stash.summary",
      kind: "summary",
      title: "Stash",
      model: () => ({ counts: [{ key: "entries", label: "entries", value: 2 }] }),
    });
    await fake.emit("session_start", { reason: "startup" }, ctx);
    const card = await env.first();
    expect(card.views.map((entry) => entry.id)).toEqual(["stash.summary"]);
    expect(card.host).toEqual({ pid: 4242, terminal: { kind: "cmux", label: "cmux" } });
    expect((await env.focus("4242")).status).toBe(200);
    expect(adapter.focus).toHaveBeenCalledTimes(1);

    let fail = true;
    defineView(fake.api.events, {
      id: SESSION_VIEW_ID,
      kind: "session",
      title: "Session",
      model: () => {
        if (fail) throw new Error("insights broke");
        return sessionModel();
      },
    });
    await waitFor(async () => view((await env.sessions())[0], SESSION_VIEW_ID) !== undefined);
    const [failed] = await env.sessions();
    expect(view(failed, SESSION_VIEW_ID)).toEqual({
      id: SESSION_VIEW_ID,
      kind: "session",
      title: "Session",
      error: "insights broke",
    });
    expect(view(failed, "stash.summary")).toBeDefined();
    fail = false;
    announceView(fake.api.events, SESSION_VIEW_ID);
    await waitFor(async () => core((await env.sessions())[0]) !== undefined);
  });

  it("Focus from the page runs the session's terminal adapter and reports failures", async () => {
    const adapter = { info: { kind: "cmux", label: "cmux" }, focus: vi.fn(async () => {}) };
    const env = setup({ detectTerminal: () => adapter });
    const fake = load(env.deps);
    const ctx = fakeCtx();
    onCleanup(() => quit(fake, ctx));
    systemView(fake);
    await fake.emit("session_start", { reason: "startup" }, ctx);
    await env.first();
    expect(await env.focus("4242")).toEqual({ status: 200, body: JSON.stringify({ ok: true }) });
    adapter.focus.mockRejectedValueOnce(new Error("cmux focus-panel: panel not found"));
    const failed = await env.focus("4242");
    expect(failed.status).toBe(502);
    expect(JSON.parse(failed.body).error).toBe("cmux focus-panel: panel not found");
  });

  it("omits the terminal outside cmux, so the page offers no Focus", async () => {
    const env = setup();
    const fake = load(env.deps);
    const ctx = fakeCtx();
    onCleanup(() => quit(fake, ctx));
    await fake.emit("session_start", { reason: "startup" }, ctx);
    expect((await env.first()).host).toEqual({ pid: 4242 });
    expect((await env.focus("4242")).status).toBe(409);
  });

  it("runs an explorer's actions from the page and returns their results to it alone", async () => {
    const env = setup();
    const fake = load(env.deps);
    const ctx = fakeCtx();
    onCleanup(() => quit(fake, ctx));
    const unflagged: unknown[] = [];
    defineView(fake.api.events, {
      id: "todo.explorer",
      kind: "explorer",
      title: "Todos",
      model: () => ({
        title: "Todos",
        items: [{ id: "fix", label: "fix: Fix auth", marked: true }],
        marker: { label: "flagged", onClear: { action: "todo.unflag", args: { branch: 1 } } },
        loadDetail: { action: "todo.inspect" },
      }),
    });
    defineAction(fake.api.events, {
      id: "todo.inspect",
      title: "Inspect",
      handler: (args) => {
        const id = isJsonObject(args) ? args.id : undefined;
        if (id !== "fix")
          throw new Error(`No task "${typeof id === "string" ? id : "?"}" on this branch.`);
        return [{ heading: "History" }, { text: "secret detail" }];
      },
    });
    defineAction(fake.api.events, {
      id: "todo.unflag",
      title: "Unflag",
      handler: (args) => {
        unflagged.push(args);
        return { unflagged: 1 };
      },
    });
    defineAction(fake.api.events, {
      id: "git.worktree.remove",
      title: "Remove a worktree",
      handler: () => {
        throw new Error("must not run");
      },
    });
    await fake.emit("session_start", { reason: "startup" }, ctx);
    await env.first();
    const hub = env.hub();
    expect(
      JSON.parse(
        (await postAction(hub, "4242", { action: "todo.inspect", args: { id: "fix" } })).body,
      ),
    ).toEqual({ ok: true, data: [{ heading: "History" }, { text: "secret detail" }] });
    const missing = await postAction(hub, "4242", { action: "todo.inspect", args: { id: "x" } });
    expect(missing.status).toBe(502);
    expect(JSON.parse(missing.body).error).toBe('No task "x" on this branch.');
    expect(
      (await postAction(hub, "4242", { action: "todo.unflag", args: { branch: 1, ids: ["fix"] } }))
        .status,
    ).toBe(200);
    expect(unflagged).toEqual([{ branch: 1, ids: ["fix"] }]);
    // Defined on the bus but offered by no view: the page cannot run it.
    expect((await postAction(hub, "4242", { action: "git.worktree.remove" })).status).toBe(409);
    expect(JSON.stringify(await env.sessions())).not.toContain("secret detail");
  });

  it("advertises forms only while connected, and answers one through its submit action", async () => {
    const env = setup();
    const fake = load(env.deps);
    const ctx = fakeCtx();
    const bus = fake.api.events;
    onCleanup(() => quit(fake, ctx));
    // Stand-in for pi-ask: one open questionnaire, answered through ask.submit.
    const open = new Map<string, FormQuestionnaire>([
      [
        "toolu_1",
        {
          id: "toolu_1",
          questions: [{ question: "Which strategy?", options: [{ label: "Retry" }] }],
          submit: { action: "ask.submit", args: { id: "toolu_1" } },
          cancel: { action: "ask.cancel", args: { id: "toolu_1" } },
        },
      ],
    ]);
    const answers: unknown[] = [];
    defineView(bus, {
      id: FORM_VIEW_ID,
      kind: "form",
      title: "Questions",
      model: () => (open.size ? { questionnaires: [...open.values()] } : undefined),
    });
    defineAction(bus, {
      id: "ask.submit",
      title: "Answer",
      handler: (args) => {
        if (!isJsonObject(args) || typeof args.id !== "string" || !open.has(args.id))
          throw new Error("Not accepted (closed): already answered");
        answers.push(args);
        open.delete(args.id);
        announceView(bus, FORM_VIEW_ID);
        return { id: args.id, status: "answered" };
      },
    });
    expect(hasFormConsumer(bus)).toBe(false);
    await fake.emit("session_start", { reason: "startup" }, ctx);
    await waitFor(async () => view((await env.sessions())[0], FORM_VIEW_ID) !== undefined);
    await waitFor(() => hasFormConsumer(bus));

    const answer = { id: "toolu_1", answers: [{ questionIndex: 0, optionIndexes: [0] }] };
    const sent = await postAction(env.hub(), "4242", { action: "ask.submit", args: answer });
    expect(JSON.parse(sent.body)).toEqual({
      ok: true,
      data: { id: "toolu_1", status: "answered" },
    });
    expect(answers).toEqual([answer]);
    // Answered: the form leaves the next snapshot and its actions are no longer offered.
    await waitFor(async () => view((await env.sessions())[0], FORM_VIEW_ID) === undefined);
    expect(
      (await postAction(env.hub(), "4242", { action: "ask.submit", args: answer })).status,
    ).toBe(409);

    // The hub goes away: the session can no longer have its forms answered from the page.
    await env.hub().stop();
    await waitFor(() => !hasFormConsumer(bus));
    // A hub comes back on the socket: once it welcomes the session, forms are advertised again.
    env.spawnHub();
    await waitFor(() => hasFormConsumer(bus), 5_000);
    await quit(fake, ctx);
    expect(hasFormConsumer(bus)).toBe(false);
  });

  it("evicts the largest views to fit one hub line, measured in UTF-8 bytes, and says so once", async () => {
    const env = setup({ maxLineBytes: 20_000 });
    const fake = load(env.deps);
    const ctx = fakeCtx();
    onCleanup(() => quit(fake, ctx));
    systemView(fake);
    // 6,000 UTF-16 units each, 12,000 bytes as UTF-8: together over the limit.
    for (const id of ["notes.a", "notes.b"])
      defineView(fake.api.events, {
        id,
        kind: "detail",
        title: id,
        model: () => ({ title: id, content: "é".repeat(6_000) }),
      });
    await fake.emit("session_start", { reason: "startup" }, ctx);
    const card = await env.first();
    expect(view(card, "notes.a")).toMatchObject({
      error: expect.stringMatching(/^Left out to fit/),
    });
    expect(view(card, "notes.b")).toMatchObject({ model: { title: "notes.b" } });
    expect(core(card)).toBeDefined();
    announceView(fake.api.events, "notes.a");
    await sleep(100);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Session dashboard: left out notes.a to fit one update.",
      "warning",
    );
  });

  it("does not report print-mode runs", async () => {
    const env = setup();
    const fake = load(env.deps);
    await fake.emit("session_start", { reason: "startup" }, fakeCtx("print"));
    await sleep(100);
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
    await sleep(100);
    expect((await env.sessions()).map((card) => card.id)).toEqual(["1"]);

    await quit(main, mainCtx);
    await waitFor(async () => (await env.sessions()).length === 0);
    await embedded.emit("session_start", { reason: "startup" }, embeddedCtx);
    await waitFor(async () => (await env.sessions())[0]?.id === "2");
  });

  it("keeps a settled card through a reload and picks it up from the new runtime", async () => {
    const env = setup();
    const before = load(env.deps);
    const ctx = fakeCtx();
    systemView(before, { name: "before", status: { kind: "working", since: 3 } });
    await before.emit("session_start", { reason: "startup" }, ctx);
    await waitFor(async () => core((await env.sessions())[0])?.name === "before");
    await before.emit("session_shutdown", { reason: "reload" }, ctx);
    const [restarting] = await waitFor(async () => {
      const list = await env.sessions();
      return list[0]?.disconnected ? list : undefined;
    });
    expect(core(restarting)).toMatchObject({ name: "before", status: { kind: "idle" } });

    const after = load(env.deps);
    onCleanup(() => quit(after, ctx));
    systemView(after, { name: "reloaded" });
    await after.emit("session_start", { reason: "reload" }, ctx);
    await waitFor(async () => {
      const [card] = await env.sessions();
      return core(card)?.name === "reloaded" && card?.disconnected === undefined;
    });
    expect(env.spawnHub).toHaveBeenCalledTimes(1);
  });

  it("/dashboard opens the URL when the hub answers", async () => {
    const env = setup();
    const openUrl = vi.fn(async () => {});
    const fake = load({ ...env.deps, openUrl, isHubReachable: async () => true });
    const ctx = fakeCtx();
    await fake.command("dashboard").handler("", ctx);
    expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:7317/");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Dashboard: http://127.0.0.1:7317/", "info");
  });

  it("/dashboard explains when no hub is running", async () => {
    const env = setup();
    const openUrl = vi.fn(async () => {});
    const fake = load({ ...env.deps, openUrl, isHubReachable: async () => false });
    const ctx = fakeCtx("print");
    await fake.command("dashboard").handler("", ctx);
    expect(openUrl).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(fake.shown()).toEqual([
      expect.objectContaining({
        customType: "dashboard:output",
        display: true,
        level: "warning",
        text: expect.stringContaining("not running"),
      }),
    ]);
  });

  it("/dashboard shows the URL as a message, without opening it, outside the terminal", async () => {
    const env = setup();
    const openUrl = vi.fn(async () => {});
    const fake = load({ ...env.deps, openUrl, isHubReachable: async () => true });
    const ctx = fakeCtx("rpc");
    await fake.command("dashboard").handler("", ctx);
    expect(openUrl).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(fake.shown()).toEqual([
      expect.objectContaining({
        level: "info",
        text: expect.stringMatching(
          /^Dashboard: http:\/\/127\.0\.0\.1:7317\/ \(.*terminal sessions/,
        ),
      }),
    ]);
  });
});
