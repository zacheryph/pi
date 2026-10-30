import { existsSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { Hub } from "#src/hub/hub";
import { LineDecoder, PROTOCOL_VERSION } from "#src/protocol";
import { fakeReporter, get, onCleanup, post, snapshot, tempDir, waitFor, type FakeReporter } from "#test/helpers";

async function startHub(options: { dir?: string; idleGraceMs?: number } = {}) {
  const hub = new Hub({ dir: options.dir ?? tempDir(), port: 0, idleGraceMs: options.idleGraceMs ?? 5_000 });
  expect(await hub.start()).toBe("started");
  onCleanup(() => hub.stop());
  return hub;
}

const sessions = async (hub: Hub) => JSON.parse((await get(hub.httpPort!, "/api/sessions")).body).sessions as Array<Record<string, unknown>>;
const hello = (overrides = {}) => ({ type: "hello", version: PROTOCOL_VERSION, snapshot: snapshot(overrides) });

describe("Hub", () => {
  it("lists a session from hello and applies updates", async () => {
    const hub = await startHub();
    const reporter = await fakeReporter(hub.paths.socket);
    reporter.send(hello({ name: "fix-auth" }));
    await waitFor(async () => (await sessions(hub)).length === 1);
    reporter.send({ type: "update", snapshot: snapshot({ name: "renamed", status: { kind: "working", since: 2 } }) });
    await waitFor(async () => (await sessions(hub))[0]?.name === "renamed");
    expect((await sessions(hub))[0]).toMatchObject({ id: "101", status: { kind: "working" } });
  });

  it("ignores updates that claim another session's id", async () => {
    const hub = await startHub();
    const a = await fakeReporter(hub.paths.socket);
    a.send(hello({ id: "a", name: "first" }));
    await waitFor(async () => (await sessions(hub)).length === 1);
    a.send({ type: "update", snapshot: snapshot({ id: "b", name: "spoof" }) });
    a.send({ type: "update", snapshot: snapshot({ id: "a", name: "second" }) });
    await waitFor(async () => (await sessions(hub))[0]?.name === "second");
    expect(await sessions(hub)).toHaveLength(1);
  });

  it("drops a session at once when its socket closes without a goodbye", async () => {
    const hub = await startHub();
    const reporter = await fakeReporter(hub.paths.socket);
    reporter.send(hello());
    await waitFor(async () => (await sessions(hub)).length === 1);
    reporter.socket.destroy();
    await waitFor(async () => (await sessions(hub)).length === 0);
  });

  it("keeps a restarting session's card through the grace period and reuses it on reconnect", async () => {
    const hub = await startHub({ idleGraceMs: 300 });
    const first = await fakeReporter(hub.paths.socket);
    first.send(hello());
    await waitFor(async () => (await sessions(hub)).length === 1);
    first.send({ type: "bye", reason: "replace" });
    first.socket.end();
    await waitFor(async () => (await sessions(hub))[0]?.restarting === true);
    const second = await fakeReporter(hub.paths.socket);
    second.send(hello({ sessionId: "session-b" }));
    await waitFor(async () => (await sessions(hub))[0]?.sessionId === "session-b");
    expect((await sessions(hub))[0]?.restarting).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await sessions(hub)).toHaveLength(1);
  });

  it("removes a restarting card that never comes back", async () => {
    const hub = await startHub({ idleGraceMs: 2_000 });
    const keepAlive = await fakeReporter(hub.paths.socket);
    keepAlive.send(hello({ id: "other" }));
    const leaving = await fakeReporter(hub.paths.socket);
    leaving.send(hello());
    await waitFor(async () => (await sessions(hub)).length === 2);
    leaving.send({ type: "bye", reason: "replace" });
    leaving.socket.end();
    await waitFor(async () => (await sessions(hub)).length === 1, 4_000);
  });

  it("stops after the grace period with no sessions and removes its socket", async () => {
    const hub = await startHub({ idleGraceMs: 100 });
    const reporter = await fakeReporter(hub.paths.socket);
    reporter.send(hello());
    await waitFor(async () => (await sessions(hub)).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
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
    await waitFor(async () => (await sessions(fresh)).length === 1);
  });

  it("steps aside for a reporter that speaks a newer protocol", async () => {
    const hub = await startHub();
    const reporter = await fakeReporter(hub.paths.socket);
    reporter.send({ type: "hello", version: PROTOCOL_VERSION + 1, snapshot: snapshot() });
    await hub.closed;
    await reporter.closed;
  });

  it("closes a connection that sends a malformed hello", async () => {
    const hub = await startHub();
    const reporter = await fakeReporter(hub.paths.socket);
    reporter.send({ type: "hello", version: PROTOCOL_VERSION, snapshot: { id: 3 } });
    await reporter.closed;
    expect(await sessions(hub)).toEqual([]);
  });

  it("serves the page and health, and rejects foreign Host headers", async () => {
    const hub = await startHub();
    const page = await get(hub.httpPort!, "/");
    expect(page.status).toBe(200);
    expect(page.type).toContain("text/html");
    expect(page.body).toContain("<title>pi dashboard</title>");
    expect(JSON.parse((await get(hub.httpPort!, "/api/health")).body)).toMatchObject({ ok: true, protocol: PROTOCOL_VERSION });
    expect((await get(hub.httpPort!, "/", `localhost:${hub.httpPort}`)).status).toBe(200);
    expect((await get(hub.httpPort!, "/api/sessions", `evil.example:${hub.httpPort}`)).status).toBe(403);
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
    reporter.send(hello({ name: "streamed" }));
    await waitFor(() => frames.join("").includes("\"name\":\"streamed\""));
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

    /** A reporter that answers each command with `answer`, recording what it was asked. */
    function commands(reporter: FakeReporter, answer?: (id: number) => Record<string, unknown> | undefined) {
      const seen: Array<{ id: number; command: string }> = [];
      const decoder = new LineDecoder();
      reporter.socket.setEncoding("utf8");
      reporter.socket.on("data", (chunk: string) => {
        for (const message of decoder.push(chunk) as Array<{ type: string; id: number; command: string }>) {
          if (message.type !== "command") continue;
          seen.push({ id: message.id, command: message.command });
          const reply = answer?.(message.id);
          if (reply) reporter.send(reply);
        }
      });
      return seen;
    }

    async function focusable(hub: Hub, answer?: (id: number) => Record<string, unknown> | undefined, overrides = {}) {
      const reporter = await fakeReporter(hub.paths.socket);
      const seen = commands(reporter, answer);
      reporter.send(hello({ terminal, ...overrides }));
      await waitFor(async () => (await sessions(hub)).length === 1);
      return { reporter, seen };
    }

    const auth = (hub: Hub) => ({ "x-dashboard-token": hub.token, origin: `http://127.0.0.1:${hub.httpPort}` });

    it("forwards a focus command to the session and returns its answer", async () => {
      const hub = await startHub();
      const { seen } = await focusable(hub, (id) => ({ type: "result", id, ok: true }));
      const response = await post(hub.httpPort!, "/api/sessions/101/focus", auth(hub));
      expect(response).toEqual({ status: 200, body: JSON.stringify({ ok: true }) });
      expect(seen).toEqual([{ id: 1, command: "focus" }]);
    });

    it("passes a session's failure back to the page", async () => {
      const hub = await startHub();
      await focusable(hub, (id) => ({ type: "result", id, ok: false, error: "cmux focus-panel: panel not found" }));
      const response = await post(hub.httpPort!, "/api/sessions/101/focus", auth(hub));
      expect(response.status).toBe(502);
      expect(JSON.parse(response.body)).toEqual({ ok: false, error: "cmux focus-panel: panel not found" });
    });

    it("requires the page's token and a same-origin request", async () => {
      const hub = await startHub();
      const { seen } = await focusable(hub, (id) => ({ type: "result", id, ok: true }));
      const port = hub.httpPort!;
      expect((await post(port, "/api/sessions/101/focus")).status).toBe(403);
      expect((await post(port, "/api/sessions/101/focus", { "x-dashboard-token": "wrong" })).status).toBe(403);
      expect((await post(port, "/api/sessions/101/focus", { ...auth(hub), origin: "http://evil.example" })).status).toBe(403);
      expect((await post(port, "/api/sessions/101/focus", { ...auth(hub), host: `evil.example:${port}` })).status).toBe(403);
      expect((await post(port, "/api/sessions/101/focus", { "x-dashboard-token": hub.token })).status).toBe(200);
      expect((await get(port, "/")).body).toContain(hub.token);
      expect(seen).toHaveLength(1);
    });

    it("explains sessions it cannot focus", async () => {
      const hub = await startHub();
      const plain = await fakeReporter(hub.paths.socket);
      plain.send(hello({ id: "plain" }));
      await waitFor(async () => (await sessions(hub)).length === 1);
      const port = hub.httpPort!;
      expect(await post(port, "/api/sessions/missing/focus", auth(hub))).toMatchObject({ status: 404 });
      const unsupported = await post(port, "/api/sessions/plain/focus", auth(hub));
      expect(unsupported.status).toBe(409);
      expect(JSON.parse(unsupported.body).error).toContain("does not support Focus");
      expect((await post(port, "/api/sessions/%E0%A4%A/focus", auth(hub))).status).toBe(400);
    });

    it("gives up on a session that does not answer, or that closes first", async () => {
      const hub = new Hub({ dir: tempDir(), port: 0, commandTimeoutMs: 100 });
      expect(await hub.start()).toBe("started");
      onCleanup(() => hub.stop());
      const silent = await focusable(hub);
      expect((await post(hub.httpPort!, "/api/sessions/101/focus", auth(hub))).status).toBe(504);
      const pending = post(hub.httpPort!, "/api/sessions/101/focus", auth(hub));
      await waitFor(() => silent.seen.length === 2);
      silent.reporter.socket.destroy();
      const closed = await pending;
      expect(closed.status).toBe(502);
      expect(JSON.parse(closed.body).error).toContain("closed");
    });

    it("relays stash preview and task history requests with their data, to the caller only", async () => {
      const hub = await startHub();
      const reporter = await fakeReporter(hub.paths.socket);
      const decoder = new LineDecoder();
      const asked: unknown[] = [];
      reporter.socket.setEncoding("utf8");
      reporter.socket.on("data", (chunk: string) => {
        for (const message of decoder.push(chunk) as Array<Record<string, unknown>>) {
          asked.push(message);
          reporter.send({ type: "result", id: message.id, ok: true, data: { echo: message.command, name: message.name ?? message.key } });
        }
      });
      reporter.send(hello());
      await waitFor(async () => (await sessions(hub)).length === 1);
      const preview = await post(hub.httpPort!, "/api/sessions/101/stash/auth%20notes/preview", auth(hub));
      expect(JSON.parse(preview.body)).toEqual({ ok: true, data: { echo: "stash-preview", name: "auth notes" } });
      const history = await post(hub.httpPort!, "/api/sessions/101/todos/fix-auth/history", auth(hub));
      expect(JSON.parse(history.body)).toEqual({ ok: true, data: { echo: "todo-history", name: "fix-auth" } });
      expect(asked).toMatchObject([{ type: "command", command: "stash-preview", name: "auth notes" }, { type: "command", command: "todo-history", key: "fix-auth" }]);
      expect((await post(hub.httpPort!, "/api/sessions/101/stash/x/preview")).status).toBe(403);
      expect((await post(hub.httpPort!, "/api/sessions/101/unknown", auth(hub))).status).toBe(404);
      expect((await get(hub.httpPort!, "/api/sessions")).body).not.toContain("echo");
    });

    it("ignores results from a different session's connection", async () => {
      const hub = new Hub({ dir: tempDir(), port: 0, commandTimeoutMs: 300 });
      expect(await hub.start()).toBe("started");
      onCleanup(() => hub.stop());
      const target = await focusable(hub);
      const other = await fakeReporter(hub.paths.socket);
      other.send(hello({ id: "other" }));
      const pending = post(hub.httpPort!, "/api/sessions/101/focus", auth(hub));
      await waitFor(() => target.seen.length === 1);
      other.send({ type: "result", id: target.seen[0]!.id, ok: true });
      expect((await pending).status).toBe(504);
    });
  });
});
