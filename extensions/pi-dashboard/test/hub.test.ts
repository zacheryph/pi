import { existsSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import type { ViewEntry } from "#surface";
import { Hub } from "#src/hub/hub";
import { MAX_LINE_BYTES, PROTOCOL_VERSION } from "#src/protocol";
import {
  core,
  fakeReporter,
  get,
  listSessions,
  onCleanup,
  post,
  postAction,
  sessionView,
  sleep,
  snapshot,
  tempDir,
  view,
  waitFor,
  type FakeReporter,
} from "#test/helpers";

async function startHub(
  options: { dir?: string; idleGraceMs?: number; commandTimeoutMs?: number } = {},
) {
  const lines: string[] = [];
  const hub = new Hub({
    dir: options.dir ?? tempDir(),
    port: 0,
    idleGraceMs: options.idleGraceMs ?? 5_000,
    ...(options.commandTimeoutMs ? { commandTimeoutMs: options.commandTimeoutMs } : {}),
    log: (line) => lines.push(line),
  });
  expect(await hub.start()).toBe("started");
  onCleanup(() => hub.stop());
  return Object.assign(hub, { lines });
}

const hello = (overrides: Parameters<typeof snapshot>[0] = {}) => ({
  type: "hello",
  version: PROTOCOL_VERSION,
  snapshot: snapshot(overrides),
});

const auth = (hub: Hub) => ({
  "x-dashboard-token": hub.token,
  origin: `http://127.0.0.1:${hub.httpPort}`,
});

const todoExplorer: ViewEntry = {
  id: "todo.explorer",
  kind: "explorer",
  title: "Todos",
  model: {
    title: "Todos",
    items: [{ id: "fix", label: "fix: Fix auth", badge: { text: "◐ in progress", live: true } }],
    loadDetail: { action: "todo.inspect" },
  },
};

const questions: ViewEntry = {
  id: "ask.questions",
  kind: "form",
  title: "Questions",
  model: {
    questionnaires: [
      {
        id: "toolu_1",
        questions: [{ question: "Which strategy?", options: [{ label: "Retry" }] }],
        submit: { action: "ask.submit", args: { id: "toolu_1" } },
        cancel: { action: "ask.cancel", args: { id: "toolu_1" } },
      },
    ],
  },
};

/** Answers each command with `answer`, recording what the hub asked. */
function answering(
  reporter: FakeReporter,
  answer?: (message: Record<string, unknown>) => Record<string, unknown> | undefined,
) {
  const seen: Array<Record<string, unknown>> = [];
  let read = 0;
  const poll = setInterval(() => {
    for (; read < reporter.received.length; read++) {
      const message = reporter.received[read]!;
      if (message.type !== "command") continue;
      seen.push(message);
      const reply = answer?.(message);
      if (reply) reporter.send({ type: "result", id: message.id, ...reply });
    }
  }, 5);
  onCleanup(() => clearInterval(poll));
  return seen;
}

describe("Hub", () => {
  it("welcomes a session's hello, lists it, and replaces it with each update", async () => {
    const hub = await startHub();
    const reporter = await fakeReporter(hub.paths.socket);
    reporter.send(
      hello({
        session: { name: "fix-auth" },
        views: [sessionView({ name: "fix-auth" }), todoExplorer],
      }),
    );
    await waitFor(async () => (await listSessions(hub)).length === 1);
    await waitFor(() => reporter.received.length > 0);
    expect(reporter.received[0]).toEqual({ type: "welcome", version: PROTOCOL_VERSION });
    const [listed] = await listSessions(hub);
    expect(listed).toEqual({
      id: "101",
      host: { pid: 101 },
      views: [sessionView({ name: "fix-auth" }), todoExplorer],
    });
    // A complete replacement: the explorer is gone because the update no longer has it.
    reporter.send({
      type: "update",
      snapshot: snapshot({ session: { name: "renamed", status: { kind: "working", since: 2 } } }),
    });
    await waitFor(async () => core((await listSessions(hub))[0])?.name === "renamed");
    const [current] = await listSessions(hub);
    expect(view(current, "todo.explorer")).toBeUndefined();
    expect(core(current)?.status).toEqual({ kind: "working", since: 2 });
  });

  it("ignores updates that claim another session's id", async () => {
    const hub = await startHub();
    const a = await fakeReporter(hub.paths.socket);
    a.send(hello({ id: "a", session: { name: "first" } }));
    await waitFor(async () => (await listSessions(hub)).length === 1);
    a.send({ type: "update", snapshot: snapshot({ id: "b", session: { name: "spoof" } }) });
    a.send({ type: "update", snapshot: snapshot({ id: "a", session: { name: "second" } }) });
    await waitFor(async () => core((await listSessions(hub))[0])?.name === "second");
    expect(await listSessions(hub)).toHaveLength(1);
  });

  it("lists a session without a system view, and keeps a failed one as its error", async () => {
    const hub = await startHub();
    const bare = await fakeReporter(hub.paths.socket);
    bare.send(
      hello({
        id: "bare",
        host: { pid: 7, terminal: { kind: "cmux", label: "cmux" } },
        views: [todoExplorer],
      }),
    );
    const failed = await fakeReporter(hub.paths.socket);
    failed.send(
      hello({
        id: "failed",
        views: [{ id: "system.session", kind: "session", title: "Session", error: "boom" }],
      }),
    );
    const listed = await waitFor(async () => {
      const sessions = await listSessions(hub);
      return sessions.length === 2 ? sessions : undefined;
    });
    expect(listed.map((record) => record.id).sort()).toEqual(["bare", "failed"]);
    expect(
      view(
        listed.find((record) => record.id === "bare"),
        "todo.explorer",
      ),
    ).toEqual(todoExplorer);
    expect(
      view(
        listed.find((record) => record.id === "failed"),
        "system.session",
      ),
    ).toMatchObject({
      error: "boom",
    });
    // Focus needs only the host's terminal, not the system view.
    const seen = answering(bare, () => ({ ok: true }));
    expect((await post(hub.httpPort!, "/api/sessions/bare/focus", auth(hub))).status).toBe(200);
    expect(seen).toMatchObject([{ command: "focus" }]);
  });

  it("drops a session at once when its socket closes without a goodbye", async () => {
    const hub = await startHub();
    const reporter = await fakeReporter(hub.paths.socket);
    reporter.send(hello());
    await waitFor(async () => (await listSessions(hub)).length === 1);
    reporter.socket.destroy();
    await waitFor(async () => (await listSessions(hub)).length === 0);
  });

  it("settles a restarting session, refuses its actions, and takes the live one back", async () => {
    const hub = await startHub({ idleGraceMs: 400 });
    const first = await fakeReporter(hub.paths.socket);
    answering(first, () => ({ ok: true }));
    first.send(
      hello({
        host: { pid: 101, terminal: { kind: "cmux", label: "cmux" } },
        views: [
          sessionView({
            status: { kind: "tool", tool: "bash", since: 5 },
            activity: [{ tool: "bash", at: 5, live: true }],
          }),
          todoExplorer,
          questions,
        ],
      }),
    );
    await waitFor(async () => (await listSessions(hub)).length === 1);
    expect(
      (await postAction(hub, "101", { action: "todo.inspect", args: { id: "fix" } })).status,
    ).toBe(200);
    first.send({ type: "bye", reason: "replace" });
    first.socket.end();
    const [settled] = await waitFor(async () => {
      const sessions = await listSessions(hub);
      return sessions[0]?.disconnected ? sessions : undefined;
    });
    // Process-bound state settles; the form, the host and the explorer's actions are gone.
    expect(settled!.host).toBeUndefined();
    expect(core(settled)?.status).toMatchObject({ kind: "idle" });
    expect(core(settled)?.activity).toEqual([{ tool: "bash", at: 5 }]);
    expect(view(settled, "ask.questions")).toBeUndefined();
    expect(view(settled, "todo.explorer")).toEqual({
      ...todoExplorer,
      model: { title: "Todos", items: [{ id: "fix", label: "fix: Fix auth" }] },
    });
    const refused = await postAction(hub, "101", { action: "todo.inspect", args: { id: "fix" } });
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.body).error).toContain("restarting");
    expect((await post(hub.httpPort!, "/api/sessions/101/focus", auth(hub))).status).toBe(409);

    const second = await fakeReporter(hub.paths.socket);
    const seen = answering(second, () => ({ ok: true, data: "detail" }));
    second.send(
      hello({
        session: { sessionId: "session-b" },
        views: [sessionView({ sessionId: "session-b" }), todoExplorer],
      }),
    );
    await waitFor(async () => core((await listSessions(hub))[0])?.sessionId === "session-b");
    const [back] = await listSessions(hub);
    expect(back?.disconnected).toBeUndefined();
    expect(
      JSON.parse(
        (await postAction(hub, "101", { action: "todo.inspect", args: { id: "fix" } })).body,
      ),
    ).toEqual({ ok: true, data: "detail" });
    expect(seen).toHaveLength(1);
    await sleep(500);
    expect(await listSessions(hub)).toHaveLength(1);
  });

  it("removes a restarting card that never comes back", async () => {
    const hub = await startHub({ idleGraceMs: 2_000 });
    const keepAlive = await fakeReporter(hub.paths.socket);
    keepAlive.send(hello({ id: "other" }));
    const leaving = await fakeReporter(hub.paths.socket);
    leaving.send(hello());
    await waitFor(async () => (await listSessions(hub)).length === 2);
    leaving.send({ type: "bye", reason: "replace" });
    leaving.socket.end();
    await waitFor(async () => (await listSessions(hub)).length === 1, 4_000);
  });

  it("stops after the grace period with no sessions and removes its socket", async () => {
    const hub = await startHub({ idleGraceMs: 100 });
    const reporter = await fakeReporter(hub.paths.socket);
    reporter.send(hello());
    await waitFor(async () => (await listSessions(hub)).length === 1);
    await sleep(200);
    expect(existsSync(hub.paths.socket)).toBe(true);
    reporter.send({ type: "bye", reason: "quit" });
    reporter.socket.end();
    await hub.closed;
    expect(existsSync(hub.paths.socket)).toBe(false);
  });

  it("stops when no session connects after startup", async () => {
    const hub = await startHub({ idleGraceMs: 50 });
    await hub.closed;
  });

  it("refuses to start beside a live hub and replaces a stale socket file", async () => {
    const dir = tempDir();
    const live = await startHub({ dir });
    const second = new Hub({ dir, port: 0 });
    expect(await second.start()).toBe("already-running");
    await live.stop();

    writeFileSync(live.paths.socket, "");
    const fresh = await startHub({ dir });
    const reporter = await fakeReporter(fresh.paths.socket);
    reporter.send(hello());
    await waitFor(async () => (await listSessions(fresh)).length === 1);
  });

  describe("protocol", () => {
    it("steps aside for a reporter that speaks a newer protocol", async () => {
      const hub = await startHub();
      const reporter = await fakeReporter(hub.paths.socket);
      reporter.send({ type: "hello", version: PROTOCOL_VERSION + 1, snapshot: snapshot() });
      await hub.closed;
      await reporter.closed;
    });

    it("refuses an older reporter explicitly, without reading its snapshot", async () => {
      const hub = await startHub();
      const reporter = await fakeReporter(hub.paths.socket);
      // Protocol 6's snapshot had sections, not views.
      reporter.send({
        type: "hello",
        version: 6,
        snapshot: {
          id: "101",
          pid: 101,
          sessionId: "s",
          cwd: "/w",
          status: { kind: "idle", since: 1 },
          startedAt: 1,
        },
      });
      await reporter.closed;
      expect(reporter.received).toEqual([
        {
          type: "refused",
          version: PROTOCOL_VERSION,
          error: `This dashboard speaks protocol ${PROTOCOL_VERSION}; the session speaks 6. Restart that Pi session to update it.`,
        },
      ]);
      expect(await listSessions(hub)).toEqual([]);
      expect(hub.lines.join("\n")).toContain("refused a reporter: This dashboard speaks protocol");
      expect(hub.httpPort).toBeDefined();
    });

    it("refuses malformed hellos and connections that do not start with one", async () => {
      const hub = await startHub();
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ type: "hello", snapshot: snapshot() }, "Malformed hello: it names no protocol version."],
        [
          { type: "hello", version: PROTOCOL_VERSION, snapshot: { id: 3 } },
          "Malformed hello: its snapshot is not a delivery snapshot.",
        ],
        [{ type: "update", snapshot: snapshot() }, "The first message must be a hello."],
      ];
      for (const [message, error] of cases) {
        const reporter = await fakeReporter(hub.paths.socket);
        reporter.send(message);
        await reporter.closed;
        expect(reporter.received).toEqual([{ type: "refused", version: PROTOCOL_VERSION, error }]);
      }
      expect(await listSessions(hub)).toEqual([]);
    });

    it("drops a line over the limit in UTF-8 bytes and keeps the connection", async () => {
      const hub = await startHub();
      const reporter = await fakeReporter(hub.paths.socket);
      reporter.send(hello({ session: { name: "first" } }));
      await waitFor(async () => (await listSessions(hub)).length === 1);
      // Fewer UTF-16 units than the limit, but more bytes: two per "é".
      const name = "é".repeat(Math.ceil(MAX_LINE_BYTES / 2) + 10);
      const line = JSON.stringify({ type: "update", snapshot: snapshot({ session: { name } }) });
      expect(line.length).toBeLessThan(MAX_LINE_BYTES);
      reporter.socket.write(`${line}\n`);
      reporter.send({ type: "update", snapshot: snapshot({ session: { name: "after" } }) });
      await waitFor(async () => core((await listSessions(hub))[0])?.name === "after");
      expect(hub.lines.join("\n")).toMatch(/dropped a line from 101: Message too large/);
    });
  });

  it("serves the page and health, and rejects foreign Host headers", async () => {
    const hub = await startHub();
    const page = await get(hub.httpPort!, "/");
    expect(page.status).toBe(200);
    expect(page.type).toContain("text/html");
    expect(page.body).toContain("<title>pi dashboard</title>");
    expect(JSON.parse((await get(hub.httpPort!, "/api/health")).body)).toMatchObject({
      ok: true,
      protocol: PROTOCOL_VERSION,
    });
    expect((await get(hub.httpPort!, "/", `localhost:${hub.httpPort}`)).status).toBe(200);
    expect((await get(hub.httpPort!, "/api/sessions", `evil.example:${hub.httpPort}`)).status).toBe(
      403,
    );
    expect((await get(hub.httpPort!, "/nope")).status).toBe(404);
  });

  it("streams session lists over server-sent events", async () => {
    const hub = await startHub();
    const frames: string[] = [];
    const req = request({ host: "127.0.0.1", port: hub.httpPort, path: "/events" }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => frames.push(chunk));
    });
    req.on("error", () => {});
    req.end();
    onCleanup(() => req.destroy());
    await waitFor(() => frames.join("").includes("event: sessions"));
    const reporter = await fakeReporter(hub.paths.socket);
    reporter.send(hello({ session: { name: "streamed" } }));
    await waitFor(() => frames.join("").includes('"name":"streamed"'));
  });

  it("retries the HTTP port while another process holds it", async () => {
    const holder = await startHub();
    const port = holder.httpPort!;
    const hub = new Hub({ dir: tempDir(), port, httpRetryMs: 50 });
    expect(await hub.start()).toBe("started");
    onCleanup(() => hub.stop());
    expect(hub.httpError).toBeDefined();
    await holder.stop();
    await waitFor(() => hub.httpPort === port);
    expect(hub.httpError).toBeUndefined();
  });

  describe("Focus", () => {
    const terminal = { kind: "cmux", label: "cmux" };

    async function focusable(
      hub: Hub,
      answer?: (message: Record<string, unknown>) => Record<string, unknown> | undefined,
    ) {
      const reporter = await fakeReporter(hub.paths.socket);
      const seen = answering(reporter, answer);
      reporter.send(hello({ host: { pid: 101, terminal } }));
      await waitFor(async () => (await listSessions(hub)).length === 1);
      return { reporter, seen };
    }

    it("forwards a focus command to the session and returns its answer", async () => {
      const hub = await startHub();
      const { seen } = await focusable(hub, () => ({ ok: true }));
      const response = await post(hub.httpPort!, "/api/sessions/101/focus", auth(hub));
      expect(response).toEqual({ status: 200, body: JSON.stringify({ ok: true }) });
      expect(seen).toEqual([{ type: "command", id: 1, command: "focus" }]);
    });

    it("passes a session's failure back to the page", async () => {
      const hub = await startHub();
      await focusable(hub, () => ({ ok: false, error: "cmux focus-panel: panel not found" }));
      const response = await post(hub.httpPort!, "/api/sessions/101/focus", auth(hub));
      expect(response.status).toBe(502);
      expect(JSON.parse(response.body)).toEqual({
        ok: false,
        error: "cmux focus-panel: panel not found",
      });
    });

    it("requires the page's token and a same-origin request", async () => {
      const hub = await startHub();
      const { seen } = await focusable(hub, () => ({ ok: true }));
      const port = hub.httpPort!;
      expect((await post(port, "/api/sessions/101/focus")).status).toBe(403);
      expect(
        (await post(port, "/api/sessions/101/focus", { "x-dashboard-token": "wrong" })).status,
      ).toBe(403);
      expect(
        (
          await post(port, "/api/sessions/101/focus", {
            ...auth(hub),
            origin: "http://evil.example",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await post(port, "/api/sessions/101/focus", {
            ...auth(hub),
            host: `evil.example:${port}`,
          })
        ).status,
      ).toBe(403);
      expect(
        (await post(port, "/api/sessions/101/focus", { "x-dashboard-token": hub.token })).status,
      ).toBe(200);
      expect((await get(port, "/")).body).toContain(hub.token);
      expect(seen).toHaveLength(1);
    });

    it("explains sessions it cannot focus", async () => {
      const hub = await startHub();
      const plain = await fakeReporter(hub.paths.socket);
      plain.send(hello({ id: "plain" }));
      await waitFor(async () => (await listSessions(hub)).length === 1);
      const port = hub.httpPort!;
      expect(await post(port, "/api/sessions/missing/focus", auth(hub))).toMatchObject({
        status: 404,
      });
      const unsupported = await post(port, "/api/sessions/plain/focus", auth(hub));
      expect(unsupported.status).toBe(409);
      expect(JSON.parse(unsupported.body).error).toContain("does not support Focus");
      expect((await post(port, "/api/sessions/%E0%A4%A/focus", auth(hub))).status).toBe(400);
    });

    it("gives up on a session that does not answer, or that closes first", async () => {
      const hub = await startHub({ commandTimeoutMs: 100 });
      const silent = await focusable(hub);
      expect((await post(hub.httpPort!, "/api/sessions/101/focus", auth(hub))).status).toBe(504);
      const pending = post(hub.httpPort!, "/api/sessions/101/focus", auth(hub));
      await waitFor(() => silent.seen.length === 2);
      silent.reporter.socket.destroy();
      const closed = await pending;
      expect(closed.status).toBe(502);
      expect(JSON.parse(closed.body).error).toContain("closed");
    });

    it("ignores results from a different session's connection", async () => {
      const hub = await startHub({ commandTimeoutMs: 300 });
      const target = await focusable(hub);
      const other = await fakeReporter(hub.paths.socket);
      other.send(hello({ id: "other" }));
      const pending = post(hub.httpPort!, "/api/sessions/101/focus", auth(hub));
      await waitFor(() => target.seen.length === 1);
      other.send({ type: "result", id: target.seen[0]!.id, ok: true });
      expect((await pending).status).toBe(504);
    });
  });

  describe("actions", () => {
    async function offering(hub: Hub, views: ViewEntry[]) {
      const reporter = await fakeReporter(hub.paths.socket);
      const seen = answering(reporter, (message) => ({
        ok: true,
        data: { echo: message.action, args: message.args ?? null },
      }));
      reporter.send(hello({ views: [sessionView(), ...views] }));
      await waitFor(async () => (await listSessions(hub)).length === 1);
      return { reporter, seen };
    }

    it("relays an offered action with its arguments and returns the result to the caller only", async () => {
      const hub = await startHub();
      const { seen } = await offering(hub, [todoExplorer, questions]);
      const detail = await postAction(hub, "101", { action: "todo.inspect", args: { id: "fix" } });
      expect(JSON.parse(detail.body)).toEqual({
        ok: true,
        data: { echo: "todo.inspect", args: { id: "fix" } },
      });
      // A form answer is its questionnaire's submit reference plus the answer's fields.
      const answer = {
        id: "toolu_1",
        answers: [{ questionIndex: 0, optionIndexes: [0] }],
        globalNote: "thanks",
      };
      const answered = await postAction(hub, "101", { action: "ask.submit", args: answer });
      expect(answered.status).toBe(200);
      expect(seen).toEqual([
        { type: "command", id: 1, command: "action", action: "todo.inspect", args: { id: "fix" } },
        { type: "command", id: 2, command: "action", action: "ask.submit", args: answer },
      ]);
      expect((await get(hub.httpPort!, "/api/sessions")).body).not.toContain("echo");
    });

    it("refuses actions no current view offers, and malformed, oversized or unauthorized bodies", async () => {
      const hub = await startHub();
      const { seen } = await offering(hub, [todoExplorer]);
      // Offered only while a form references it.
      const stale = await postAction(hub, "101", { action: "ask.submit", args: { id: "q" } });
      expect(stale.status).toBe(409);
      expect(JSON.parse(stale.body).error).toContain("no longer offers");
      expect((await postAction(hub, "101", { action: "git.worktree.remove" })).status).toBe(409);
      expect((await postAction(hub, "101", { action: "Not valid" })).status).toBe(400);
      expect((await postAction(hub, "101", { args: {} })).status).toBe(400);
      const port = hub.httpPort!;
      expect((await post(port, "/api/sessions/101/actions", auth(hub), "{not json")).status).toBe(
        400,
      );
      expect(
        (
          await post(
            port,
            "/api/sessions/101/actions",
            auth(hub),
            JSON.stringify({ action: "todo.inspect", args: { text: "x".repeat(70_000) } }),
          )
        ).status,
      ).toBe(413);
      expect(
        (
          await post(
            port,
            "/api/sessions/101/actions",
            {},
            JSON.stringify({ action: "todo.inspect", args: { id: "fix" } }),
          )
        ).status,
      ).toBe(403);
      // The old fixed routes are gone.
      expect((await post(port, "/api/sessions/101/stash/x/preview", auth(hub))).status).toBe(404);
      expect((await post(port, "/api/sessions/101/questions/q/answer", auth(hub))).status).toBe(
        404,
      );
      expect(seen).toEqual([]);
    });

    it("stops offering a form's actions once an update withdraws it", async () => {
      const hub = await startHub();
      const { reporter, seen } = await offering(hub, [questions]);
      expect(
        (await postAction(hub, "101", { action: "ask.cancel", args: { id: "toolu_1" } })).status,
      ).toBe(200);
      reporter.send({ type: "update", snapshot: snapshot() });
      await waitFor(async () => view((await listSessions(hub))[0], "ask.questions") === undefined);
      expect(
        (await postAction(hub, "101", { action: "ask.cancel", args: { id: "toolu_1" } })).status,
      ).toBe(409);
      expect(seen).toHaveLength(1);
    });
  });
});
