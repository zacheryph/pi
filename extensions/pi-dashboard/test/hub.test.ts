import { existsSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { Hub } from "#src/hub/hub";
import { PROTOCOL_VERSION } from "#src/protocol";
import { fakeReporter, get, onCleanup, snapshot, tempDir, waitFor } from "#test/helpers";

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
});
