import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
// The frozen reproduction of the stale-running card: a snapshot saved while subagents ran.
import { staleRunningCard } from "../../packages/pi-surface/test/fixtures/stale-running-card.ts";
import { SAVED_SNAPSHOT_VERSION } from "../archive.ts";
import type { DeliverySnapshot, FormQuestionnaire, ViewEntry } from "../contract.ts";
import { MAX_MESSAGE_BYTES, parseSessionMessage } from "../protocol.ts";
import { createPlugin } from "../server.ts";
import { SessionStore } from "../sessions.ts";
import { openQuestionnaires, viewModel } from "../views.ts";

const THREAD = "thr_live";

const sessionView = (overrides: Record<string, unknown> = {}): ViewEntry => ({
  id: "system.session",
  kind: "session",
  title: "Session",
  model: {
    sessionId: "session-a",
    cwd: "/work/api",
    status: { kind: "idle", since: 1 },
    startedAt: 1,
    ...overrides,
  } as never,
});

function snapshot(views: readonly ViewEntry[] = [sessionView()], id = "4242"): DeliverySnapshot {
  return { id, host: { pid: Number(id) || 1 }, views };
}

const questionnaire = (id = "toolu_1"): FormQuestionnaire => ({
  id,
  title: "Retry policy",
  questions: [
    { question: "Retry on 429?", options: [{ label: "Yes" }, { label: "No" }] },
    { question: "Anything else?", options: [] },
  ],
  submit: { action: "ask.submit", args: { id } },
  cancel: { action: "ask.cancel", args: { id } },
});

const formView = (...questionnaires: FormQuestionnaire[]): ViewEntry => ({
  id: "ask.questions",
  kind: "form",
  title: "Questions",
  model: { questionnaires },
});

const hosts: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

const OPTIONS = { graceMs: 30, helloTimeoutMs: 200, requestTimeoutMs: 300 };
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

type Socket = Awaited<
  ReturnType<
    ReturnType<typeof createFakePluginHost>["harness"]["behavior"]["experimental_openWebSocket"]
  >
>;

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "pi-surface" });
  await createPlugin(OPTIONS)(bb);
  hosts.push({ dispose: () => harness.lifecycle.dispose() });
  const tokenFor = async (threadId: string) => {
    const entries = await harness.behavior.resolveProviderEnv("pi", {
      threadId,
      projectId: "proj_1",
      hostId: "host_1",
    });
    return entries.find((entry) => entry.name === "PI_BB_SURFACE_TOKEN")!.value as string;
  };
  const hello = async (socket: Socket, threadId: string, sent: DeliverySnapshot) =>
    socket.receive(
      JSON.stringify({
        type: "hello",
        version: 3,
        threadId,
        token: await tokenFor(threadId),
        snapshot: sent,
      }),
    );
  const connect = async (threadId = THREAD, sent: DeliverySnapshot = snapshot()) => {
    const socket = await harness.behavior.experimental_openWebSocket("/session");
    await hello(socket, threadId, sent);
    return socket;
  };
  const update = (socket: Socket, sent: DeliverySnapshot) =>
    socket.receive(JSON.stringify({ type: "update", snapshot: sent }));
  const read = (threadId = THREAD) =>
    harness.behavior.callRpc("snapshot", { threadId }) as Promise<{
      snapshot: DeliverySnapshot | null;
      source: string | null;
      connected: boolean;
    }>;
  const sessions = () =>
    harness.behavior.callRpc("sessions", null) as Promise<{ sessions: Array<Record<string, any>> }>;
  const request = (body: unknown, threadId = THREAD) =>
    harness.behavior.callRpc("request", { threadId, request: body }) as Promise<{
      value: unknown;
    }>;
  /** A bb restart or plugin reload: a new generation over the same storage. */
  const reload = async () => {
    const next = await harness.lifecycle.reload(createPlugin(OPTIONS));
    hosts.push({ dispose: () => next.harness.lifecycle.dispose() });
    return {
      read: (threadId = THREAD) =>
        next.harness.behavior.callRpc("snapshot", { threadId }) as ReturnType<typeof read>,
      harness: next.harness,
    };
  };
  return { bb, harness, tokenFor, hello, connect, update, read, sessions, request, reload };
}

/** Messages the plugin sent on a socket, parsed. */
const sent = (socket: { sent: readonly (string | Uint8Array)[] }) =>
  socket.sent.map(
    (data) =>
      JSON.parse(String(data)) as { type: string; id: number; version?: number; request: any },
  );
const requests = (socket: Socket) => sent(socket).filter((message) => message.type === "request");

/** Answers the nth request on a socket, as pi-bb would. */
async function answer(socket: Socket, index: number, result: Record<string, unknown>) {
  await tick();
  const asked = requests(socket)[index]!;
  await socket.receive(JSON.stringify({ type: "result", id: asked.id, ...result }));
  return asked;
}

describe("pi-surface server", () => {
  it("gives every Pi thread its endpoint and a per-thread token, and nothing to model listing", async () => {
    const { harness, tokenFor } = await setup();
    const entries = await harness.behavior.resolveProviderEnv("pi", {
      threadId: THREAD,
      projectId: "proj_1",
      hostId: "host_1",
    });
    expect(entries.map((entry) => [entry.name, entry.value])).toEqual([
      ["PI_BB_SURFACE_URL", { serverPath: "/api/v1/plugins/pi-surface/http/session" }],
      ["PI_BB_SURFACE_TOKEN", expect.any(String)],
    ]);
    expect(await tokenFor(THREAD)).toBe(await tokenFor(THREAD));
    expect(await tokenFor(THREAD)).not.toBe(await tokenFor("thr_other"));
    expect(
      await harness.behavior.resolveProviderEnv("pi", {
        threadId: null,
        projectId: null,
        hostId: "host_1",
      }),
    ).toEqual([]);
  });

  it("welcomes a session's hello, serves its snapshot and replaces it with each update", async () => {
    const { harness, connect, update, read, sessions } = await setup();
    expect(await read()).toEqual({ snapshot: null, source: null, connected: false });
    const todos: ViewEntry = {
      id: "todo.summary",
      kind: "summary",
      title: "Tasks",
      model: { counts: [{ key: "total", label: "tasks", value: 2 }] },
    };
    const socket = await connect(THREAD, snapshot([sessionView(), todos]));
    expect(sent(socket)).toEqual([{ type: "welcome", version: 3 }]);
    expect(await read()).toMatchObject({ source: "live", connected: true });
    expect((await read()).snapshot?.views.map((view) => view.id)).toEqual([
      "system.session",
      "todo.summary",
    ]);
    // The whole view set is replaced: a view the update leaves out is gone.
    await update(socket, snapshot([sessionView({ name: "renamed" })]));
    expect((await read()).snapshot?.views).toEqual([sessionView({ name: "renamed" })]);
    expect(harness.inspection.experimental_rpcInvalidations).toContainEqual([
      `thread:${THREAD}`,
      "sessions",
    ]);
    expect((await sessions()).sessions).toEqual([
      expect.objectContaining({
        threadId: THREAD,
        source: "live",
        connected: true,
        status: "idle",
        name: "renamed",
        cwd: "/work/api",
        runningAgents: 0,
        questions: 0,
      }),
    ]);
  });

  it("lists a session from its summaries: profile without subagents, counts, active task, questions", async () => {
    const { connect, sessions } = await setup();
    const views: ViewEntry[] = [
      formView(questionnaire()),
      sessionView({
        name: "Fix auth",
        status: { kind: "waiting", title: "Retry policy", since: 1 },
        model: { provider: "anthropic", id: "opus", name: "Opus" },
      }),
      {
        id: "subagent.summary",
        kind: "summary",
        title: "Subagents",
        model: {
          counts: [
            { key: "running", label: "running", value: 0, live: true },
            { key: "queued", label: "queued", value: 0, live: true },
            { key: "total", label: "subagents", value: 0 },
          ],
          profile: { name: "orchestrate", label: "Orchestrator" },
        },
      },
      {
        id: "todo.summary",
        kind: "summary",
        title: "Tasks",
        model: {
          counts: [
            { key: "total", label: "tasks", value: 12 },
            { key: "completed", label: "completed", value: 5 },
          ],
          active: { id: "fix", label: "Fix the retry loop" },
        },
      },
    ];
    await connect(THREAD, snapshot(views));
    expect((await sessions()).sessions[0]).toEqual({
      threadId: THREAD,
      source: "live",
      connected: true,
      updatedAt: expect.any(Number),
      cwd: "/work/api",
      name: "Fix auth",
      status: "waiting",
      model: "Opus",
      profile: "Orchestrator",
      todos: { done: 5, total: 12, active: "Fix the retry loop" },
      runningAgents: 0,
      questions: 1,
    });
  });

  it("lists and serves a session that has no system view", async () => {
    const { connect, read, sessions, harness } = await setup();
    const stash: ViewEntry = { id: "stash.summary", kind: "summary", title: "Stash", error: "x" };
    await connect(THREAD, snapshot([stash]));
    expect((await read()).snapshot?.views).toEqual([stash]);
    const [row] = (await sessions()).sessions;
    expect(row).toMatchObject({ threadId: THREAD, source: "live", runningAgents: 0 });
    expect(row).not.toHaveProperty("status");
    expect(row).not.toHaveProperty("cwd");
    expect((await harness.behavior.runCli(["list"])).stdout).toContain(
      `${THREAD}  live  unknown  (no session view)`,
    );
  });

  it("refuses another thread's token, another protocol version and sessions that never say hello", async () => {
    const { harness, tokenFor, read } = await setup();
    const forged = await harness.behavior.experimental_openWebSocket("/session");
    await forged.receive(
      JSON.stringify({
        type: "hello",
        version: 3,
        threadId: THREAD,
        token: await tokenFor("thr_other"),
        snapshot: snapshot(),
      }),
    );
    expect(forged.closeCalls).toEqual([{ code: 4401, reason: "bad token" }]);
    // A protocol 2 pi-bb sends its older snapshot shape: refused for its version, not read.
    const older = await harness.behavior.experimental_openWebSocket("/session");
    await older.receive(
      JSON.stringify({
        type: "hello",
        version: 2,
        threadId: THREAD,
        token: await tokenFor(THREAD),
        snapshot: { id: "1", sessionId: "s", cwd: "/w", status: { kind: "idle", since: 1 } },
      }),
    );
    expect(older.closeCalls).toEqual([{ code: 4400, reason: "protocol 3 expected, got 2" }]);
    expect(sent(older)).toEqual([]);
    const silent = await harness.behavior.experimental_openWebSocket("/session");
    await silent.receive(JSON.stringify({ type: "update", snapshot: snapshot() }));
    await tick(250);
    expect(silent.closeCalls[0]?.code).toBe(4401);
    expect((await read()).snapshot).toBeNull();
  });

  it("drops malformed messages with a warning and keeps the last good snapshot", async () => {
    const { harness, connect, read } = await setup();
    const socket = await connect();
    for (const bad of [
      "not json",
      JSON.stringify({ type: "update", snapshot: { id: "4242" } }),
      JSON.stringify({ type: "update", snapshot: snapshot(), extra: 1 }),
      JSON.stringify({ type: "bye", reason: "later" }),
      JSON.stringify({ type: "result", id: 1, ok: false }),
    ])
      await socket.receive(bad);
    expect((await read()).snapshot).toEqual(snapshot());
    const warnings = harness.inspection.logEntries.filter((entry) => entry.level === "warn");
    expect(warnings).toHaveLength(5);
    expect(warnings[0]!.message).toContain("Message is not JSON");
  });

  it("measures messages in UTF-8 bytes, not UTF-16 units", () => {
    // 700,000 euro signs: 700k UTF-16 units, 2.1 MB of UTF-8, over the 2 MiB limit.
    const wide = JSON.stringify({
      type: "update",
      snapshot: snapshot([], "€".repeat(100)),
    }).replace("€".repeat(100), "€".repeat(700_000));
    expect(wide.length).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(parseSessionMessage(wide)).toMatchObject({
      ok: false,
      error: expect.stringContaining("too large"),
    });
    // The same bytes as a Uint8Array, and ASCII just under the limit, which is read.
    expect(parseSessionMessage(new TextEncoder().encode(wide))).toMatchObject({ ok: false });
    const view = (text: string): ViewEntry => ({
      id: "notes.big",
      kind: "detail",
      title: "Notes",
      model: { title: "Notes", content: text },
    });
    const near = JSON.stringify({ type: "update", snapshot: snapshot([view("")]) });
    const fits = near.replace(
      '"content":""',
      `"content":"${"a".repeat(MAX_MESSAGE_BYTES - near.length)}"`,
    );
    expect(new TextEncoder().encode(fits).length).toBe(MAX_MESSAGE_BYTES);
    expect(parseSessionMessage(fits)).toMatchObject({ ok: true });
  });

  it("runs the app's action requests on the session and returns its value or error", async () => {
    const { harness, connect, request } = await setup();
    const socket = await connect();
    const detail = request({ action: "stash.inspect", args: { id: "stash:notes@0123" } });
    const asked = await answer(socket, 0, { ok: true, value: [{ lines: ["a"] }] });
    expect(asked.request).toEqual({ action: "stash.inspect", args: { id: "stash:notes@0123" } });
    expect(await detail).toEqual({ value: [{ lines: ["a"] }] });

    const nothing = request({ action: "todo.review", args: { ids: ["a"] } });
    await answer(socket, 1, { ok: true });
    expect(await nothing).toEqual({ value: null });

    // An action that fails reaches the app with the session's message.
    const failing = request({ action: "todo.inspect", args: { id: "gone" } });
    await answer(socket, 2, { ok: false, error: 'No task "gone" on this branch.' });
    await expect(failing).rejects.toThrow('No task "gone" on this branch.');

    // A session that never answers, and one that goes away mid-request.
    await expect(request({ action: "todo.inspect", args: { id: "slow" } })).rejects.toThrow(
      "did not answer in time",
    );
    const cut = request({ action: "todo.inspect", args: { id: "cut" } });
    await tick();
    await socket.close();
    await expect(cut).rejects.toThrow("disconnected");

    await expect(request({ action: "todo.inspect" }, "thr_none")).rejects.toMatchObject({
      code: "not_found",
    });
    // Only well-formed action requests reach a session.
    await expect(request({ action: "Not An Id" })).rejects.toThrow();
    await expect(request({ command: "action", id: "todo.inspect" })).rejects.toThrow();
    await expect(request({ action: "todo.inspect", extra: 1 })).rejects.toThrow();
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
  });

  it("keeps a disconnected session live through the grace period, then shows it settled as saved", async () => {
    const { connect, read, request } = await setup();
    const socket = await connect();
    await socket.close(1000, "replace");
    expect(await read()).toMatchObject({ source: "live", connected: false });
    const again = await connect(THREAD, snapshot([sessionView({ name: "after reload" })]));
    expect(await read()).toMatchObject({ connected: true });
    await again.close();
    await tick(60);
    const saved = await read();
    expect(saved).toMatchObject({ source: "saved", connected: false });
    expect(saved.snapshot).toEqual({ id: "4242", views: [sessionView({ name: "after reload" })] });
    await expect(request({ action: "todo.inspect", args: { id: "x" } })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("next turn"),
    });
  });

  it("restores a saved card settled: nothing runs, no form, only included details open", async () => {
    const { connect, update, reload, harness } = await setup();
    const card = structuredClone(staleRunningCard) as unknown as DeliverySnapshot;
    const socket = await connect(THREAD, snapshot([sessionView()]));
    await update(socket, card);
    // The live session raised its form; the restored one never does.
    expect(harness.inspection.pendingInteractions).toHaveLength(1);
    const next = await reload();
    const restored = await next.read();
    expect(restored).toMatchObject({ source: "saved", connected: false });
    const views = restored.snapshot!;
    expect(views).not.toHaveProperty("host");
    expect(openQuestionnaires(views)).toEqual([]);
    expect(views.views.map((view) => view.id)).not.toContain("ask.questions");
    const session = viewModel(views, "system.session", "session")!;
    expect(session.status.kind).toBe("idle");
    expect(session.activity?.some((call) => call.live)).toBe(false);
    const widget = viewModel(views, "subagent.widget", "widget")!;
    expect(widget.active).toBe(false);
    expect(JSON.stringify(widget)).not.toContain('"since"');
    expect(widget.rows.map((row) => row.group)).toEqual(["stopped", "stopped", "finished"]);
    const explorer = viewModel(views, "subagent.explorer", "explorer")!;
    expect(explorer.items.map((item) => item.badge?.text)).toEqual(["stopped", undefined, "done"]);
    expect(explorer.loadDetail).toBeUndefined();
    const summary = viewModel(views, "subagent.summary", "summary")!;
    expect(summary.counts.filter((count) => count.value > 0).map((count) => count.key)).toEqual([
      "completed",
    ]);
    expect(summary.active).toBeUndefined();
    expect(summary.profile).toEqual({ name: "default", label: "Default agent" });
    // Persisted task state is kept, and its actions are gone with Pi.
    expect(viewModel(views, "todo.widget", "widget")).toEqual(
      (staleRunningCard.views.find((view) => view.id === "todo.widget") as { model: unknown })
        .model,
    );
    expect(viewModel(views, "todo.explorer", "explorer")).not.toHaveProperty("loadDetail");
    expect(viewModel(views, "todo.summary", "summary")?.active?.id).toBe("2");
    expect(next.harness.inspection.pendingInteractions).toHaveLength(0);
    expect((await next.harness.behavior.callRpc("sessions", null)) as unknown).toMatchObject({
      sessions: [{ threadId: THREAD, source: "saved", runningAgents: 0, questions: 0 }],
    });
  });

  it("ignores saved records of an older version or malformed, with one warning, and repopulates live", async () => {
    const { bb, connect, reload } = await setup();
    await connect("thr_good");
    // Rows written before records were versioned, and rows this version cannot read.
    const db = bb.storage.database();
    const insert = db.prepare(
      "INSERT INTO snapshots (thread_id, snapshot, saved_at, version) VALUES (?, ?, ?, ?)",
    );
    const now = Date.now();
    insert.run("thr_old", JSON.stringify({ id: "1", sessionId: "s", cwd: "/w" }), now, 0);
    insert.run("thr_unversioned", JSON.stringify(snapshot()), now, 0);
    insert.run("thr_garbled", "{not json", now, SAVED_SNAPSHOT_VERSION);
    insert.run(
      "thr_shape",
      JSON.stringify({ id: "1", views: [{ id: "x" }] }),
      now,
      SAVED_SNAPSHOT_VERSION,
    );
    insert.run("thr_future", JSON.stringify(snapshot()), now, SAVED_SNAPSHOT_VERSION + 1);

    const next = await reload();
    for (const thread of ["thr_old", "thr_unversioned", "thr_garbled", "thr_shape", "thr_future"])
      expect((await next.read(thread)).snapshot).toBeNull();
    expect(await next.read("thr_good")).toMatchObject({ source: "saved" });
    const warnings = next.harness.inspection.logEntries.filter((entry) =>
      entry.message.includes("snapshot archive"),
    );
    expect(warnings).toEqual([
      {
        level: "warn",
        message: expect.stringContaining("ignored 5 saved snapshots of an older version"),
      },
    ]);
    // Unreadable records are gone, so the next load does not warn again.
    const again = await next.harness.lifecycle.reload(createPlugin(OPTIONS));
    hosts.push({ dispose: () => again.harness.lifecycle.dispose() });
    expect(
      again.harness.inspection.logEntries.filter((entry) =>
        entry.message.includes("snapshot archive"),
      ),
    ).toEqual([]);
  });

  it("forgets a deleted thread's snapshot, across restarts too", async () => {
    const { harness, connect, read, reload } = await setup();
    const socket = await connect();
    await socket.close();
    await tick(60);
    expect((await read()).source).toBe("saved");
    await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: { id: THREAD } as never,
    });
    expect((await read()).snapshot).toBeNull();
    expect((await (await reload()).read()).snapshot).toBeNull();
  });

  it("lets the newest process for a thread take over", async () => {
    const { connect, read, request } = await setup();
    const first = await connect(THREAD, snapshot([sessionView({ name: "first" })], "1111"));
    const waiting = request({ action: "todo.inspect", args: { id: "a" } });
    await tick();
    const second = await connect(THREAD, snapshot([sessionView({ name: "second" })], "2222"));
    expect(first.closeCalls).toEqual([{ code: 4409, reason: "replaced" }]);
    await expect(waiting).rejects.toThrow("disconnected");
    expect((await read()).snapshot?.id).toBe("2222");
    const fresh = request({ action: "todo.inspect", args: { id: "b" } });
    await answer(second, 0, { ok: true, value: "from second" });
    expect(await fresh).toEqual({ value: "from second" });
  });

  it("never lets a replaced connection's late update or result affect its replacement", async () => {
    // At the store, where a message that was already in flight when bb closed the socket lands.
    const changes: string[] = [];
    const store = new SessionStore({
      verify: () => true,
      onChange: (threadId) => changes.push(threadId),
      requestTimeoutMs: 1_000,
    });
    const socket = () => ({
      sent: [] as string[],
      send(data: string) {
        this.sent.push(data);
      },
      close() {},
    });
    const hello = (id: string) =>
      JSON.stringify({
        type: "hello",
        version: 3,
        threadId: THREAD,
        token: "t",
        snapshot: snapshot([], id),
      });
    const oldSocket = socket();
    const old = store.open(oldSocket);
    await old.message(hello("1111"));
    const pending = store.request(THREAD, { action: "todo.inspect" });
    const asked = JSON.parse(oldSocket.sent.at(-1)!) as { id: number };
    const newSocket = socket();
    const replacement = store.open(newSocket);
    await replacement.message(hello("2222"));
    await expect(pending).rejects.toThrow("disconnected");
    const fresh = store.request(THREAD, { action: "todo.inspect" });
    const freshId = (JSON.parse(newSocket.sent.at(-1)!) as { id: number }).id;
    const before = changes.length;

    await old.message(JSON.stringify({ type: "update", snapshot: snapshot([], "1111") }));
    store.update(old, snapshot([sessionView({ name: "late" })], "1111"));
    await old.message(JSON.stringify({ type: "result", id: asked.id, ok: true, value: "late" }));
    store.settle(old, freshId, { ok: true, value: "forged" });
    expect(store.get(THREAD).snapshot?.id).toBe("2222");
    expect(changes.length).toBe(before);

    await replacement.message(
      JSON.stringify({ type: "result", id: freshId, ok: true, value: "ok" }),
    );
    expect(await fresh).toBe("ok");
    store.dispose();
  });

  it("installs, lists and clears a fixture session from the CLI, and answers its requests", async () => {
    const { harness, read, connect, request } = await setup();
    expect((await harness.behavior.runCli(["fixture"])).exitCode).toBe(1);
    const installed = await harness.behavior.runCli(["fixture", "--thread", "thr_demo"]);
    expect(installed).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("thr_demo") });
    const result = await read("thr_demo");
    expect(result).toMatchObject({ source: "fixture", connected: true });
    // The fixture has an open form, but a fixture never raises a real question.
    expect(openQuestionnaires(result.snapshot)).toHaveLength(1);
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
    expect((await harness.behavior.runCli(["list"])).stdout).toContain("thr_demo  fixture");
    expect(
      await request(
        { action: "stash.inspect", args: { id: "stash:review-notes@3f9c2a81d0e4" } },
        "thr_demo",
      ),
    ).toMatchObject({
      value: expect.arrayContaining([expect.objectContaining({ lines: expect.any(Array) })]),
    });
    await expect(
      request({ action: "ask.submit", args: { id: "fixture-ask-1", answers: [] } }, "thr_demo"),
    ).rejects.toThrow("fixture");

    await connect();
    expect((await harness.behavior.runCli(["fixture", "--thread", THREAD])).exitCode).toBe(1);
    expect((await harness.behavior.runCli(["clear", "--thread", THREAD])).exitCode).toBe(1);
    expect((await harness.behavior.runCli(["clear", "--thread", "thr_demo"])).exitCode).toBe(0);
    expect((await read("thr_demo")).snapshot).toBeNull();
  });
});

describe("live forms", () => {
  it("raises each open questionnaire as a form and submits the answer through its submit action", async () => {
    const { harness, connect, update } = await setup();
    const socket = await connect(
      THREAD,
      snapshot([formView(questionnaire("q1"), questionnaire("q2"))]),
    );
    expect(harness.inspection.pendingInteractions).toMatchObject([
      {
        threadId: THREAD,
        rendererId: "questionnaire",
        title: "Retry policy",
        payload: { id: "q1" },
      },
      { threadId: THREAD, rendererId: "questionnaire", payload: { id: "q2" } },
    ]);
    harness.behavior.submitInteraction(harness.inspection.pendingInteractions[0]!.id, {
      answers: [
        { questionIndex: 0, optionIndexes: [1] },
        { questionIndex: 1, text: " later ", junk: true },
      ],
      globalNote: " thanks ",
    });
    const asked = await answer(socket, 0, { ok: true, value: { id: "q1", status: "answered" } });
    expect(asked.request).toEqual({
      action: "ask.submit",
      args: {
        id: "q1",
        answers: [
          { questionIndex: 0, optionIndexes: [1] },
          { questionIndex: 1, text: "later" },
        ],
        globalNote: "thanks",
      },
    });
    // Until pi-ask's next snapshot drops it, an answered questionnaire is not raised again.
    await update(socket, snapshot([formView(questionnaire("q1"), questionnaire("q2"))]));
    expect(harness.inspection.pendingInteractions.map((item) => item.payload)).toEqual([
      expect.objectContaining({ id: "q2" }),
    ]);
    await update(socket, snapshot([formView(questionnaire("q2"))]));
    expect(harness.inspection.pendingInteractions).toHaveLength(1);
  });

  it("declines through the questionnaire's cancel action", async () => {
    const { harness, connect } = await setup();
    const socket = await connect(THREAD, snapshot([formView(questionnaire())]));
    harness.behavior.cancelInteraction(harness.inspection.pendingInteractions[0]!.id);
    const asked = await answer(socket, 0, { ok: true });
    expect(asked.request).toEqual({ action: "ask.cancel", args: { id: "toolu_1" } });
  });

  it("raises the form again when Pi refuses the answer", async () => {
    const { harness, connect } = await setup();
    const socket = await connect(THREAD, snapshot([formView(questionnaire())]));
    harness.behavior.submitInteraction(harness.inspection.pendingInteractions[0]!.id, {
      answers: [{ questionIndex: 0, optionIndexes: [0] }],
    });
    await answer(socket, 0, {
      ok: false,
      error: "Not accepted (invalid_answer): Answer every question.",
    });
    await tick();
    expect(harness.inspection.pendingInteractions).toHaveLength(1);
    expect(harness.inspection.logEntries).toContainEqual({
      level: "warn",
      message: expect.stringContaining("Answer every question."),
    });
  });

  it("withdraws a form when its questionnaire closes, the connection goes, or another process takes over", async () => {
    const { harness, connect, update } = await setup();
    // Pi closed it (answered in the terminal, or the tool was aborted).
    const socket = await connect(THREAD, snapshot([formView(questionnaire())]));
    expect(harness.inspection.pendingInteractions).toHaveLength(1);
    await update(socket, snapshot([sessionView()]));
    await tick();
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
    expect(requests(socket)).toHaveLength(0);

    // The connection went: nobody can answer, even within the grace period.
    await update(socket, snapshot([formView(questionnaire())]));
    expect(harness.inspection.pendingInteractions).toHaveLength(1);
    await socket.close(1000, "replace");
    await tick();
    expect(harness.inspection.pendingInteractions).toHaveLength(0);

    // A new process with the same questionnaire id is another session: its own form is raised.
    const first = await connect(THREAD, snapshot([formView(questionnaire())], "1111"));
    const [raised] = harness.inspection.pendingInteractions;
    await connect(THREAD, snapshot([formView(questionnaire())], "2222"));
    await tick();
    expect(first.closeCalls[0]?.code).toBe(4409);
    expect(harness.inspection.pendingInteractions).toHaveLength(1);
    expect(harness.inspection.pendingInteractions[0]!.id).not.toBe(raised!.id);
  });

  it("never sends an old connection's form answer to its replacement", async () => {
    const answers: unknown[] = [];
    const { harness, connect } = await setup();
    await connect(THREAD, snapshot([formView(questionnaire())], "1111"));
    const [old] = harness.inspection.pendingInteractions;
    const second = await connect(THREAD, snapshot([sessionView()], "2222"));
    // bb delivers a submission for a form that was already withdrawn: it goes nowhere.
    try {
      harness.behavior.submitInteraction(old!.id, { answers: [] });
    } catch (error) {
      answers.push(error);
    }
    await tick();
    expect(requests(second)).toEqual([]);
  });

  it("raises no form for a saved session", async () => {
    const { harness, reload, connect } = await setup();
    const socket = await connect(THREAD, snapshot([formView(questionnaire())]));
    await socket.close();
    await tick(60);
    const next = await reload();
    expect((await next.read()).source).toBe("saved");
    expect(next.harness.inspection.pendingInteractions).toHaveLength(0);
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
  });

  it("closes sessions and withdraws forms when the plugin is disposed; pi-bb reconnects to the next generation", async () => {
    const { harness, connect } = await setup();
    const socket = await connect(THREAD, snapshot([formView(questionnaire())]));
    await harness.lifecycle.dispose();
    hosts.length = 0;
    // bb closes the old generation's sockets with 1012, which pi-bb retries.
    expect(socket.closeCalls.map((call) => call.code)).toContain(1012);
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
  });
});
