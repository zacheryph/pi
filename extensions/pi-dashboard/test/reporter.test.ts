import { createServer, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { Hub } from "#src/hub/hub";
import { encode, hubPaths, LineDecoder, MAX_LINE_BYTES, PROTOCOL_VERSION } from "#src/protocol";
import { Reporter } from "#src/reporter";
import { core, listSessions, onCleanup, sleep, snapshot, tempDir, waitFor } from "#test/helpers";

function inProcessHub(dir: string) {
  const hubs: Hub[] = [];
  onCleanup(() => Promise.all(hubs.map((hub) => hub.stop())));
  const spawn = vi.fn(() => {
    const hub = new Hub({ dir, port: 0 });
    hubs.push(hub);
    void hub.start();
  });
  return { spawn, latest: () => hubs.at(-1) };
}

function reporter(
  dir: string,
  spawnHub: () => void,
  extra: Partial<ConstructorParameters<typeof Reporter>[0]> = {},
) {
  const instance = new Reporter({
    socketPath: hubPaths(dir).socket,
    spawnHub,
    minDelayMs: 10,
    maxDelayMs: 50,
    ...extra,
  });
  onCleanup(() => instance.close("quit"));
  return instance;
}

const json = (name: string) => JSON.stringify(snapshot({ session: { name } }));

/** A stand-in hub on the socket that answers each hello with `reply` and records what it read. */
function scriptedHub(path: string, reply: (socket: Socket) => void) {
  const read: unknown[] = [];
  const server = createServer((socket) => {
    const decoder = new LineDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const decoded of decoder.push(chunk)) {
        if (!decoded.ok) continue;
        read.push(decoded.value);
        if ((decoded.value as { type?: string }).type === "hello") reply(socket);
      }
    });
    socket.on("error", () => {});
  });
  onCleanup(() => new Promise((resolve) => server.close(resolve)));
  return new Promise<{ read: unknown[] }>((resolve) =>
    server.listen(path, () => resolve({ read })),
  );
}

describe("Reporter", () => {
  it("spawns a hub when none listens, then says hello and sends updates", async () => {
    const dir = tempDir();
    const hub = inProcessHub(dir);
    const connected = vi.fn();
    const r = reporter(dir, hub.spawn, { onConnected: connected });
    r.update(json("first"));
    r.start();
    await waitFor(async () => core((await listSessions(hub.latest()))[0])?.name === "first");
    expect(hub.spawn).toHaveBeenCalledTimes(1);
    await waitFor(() => connected.mock.calls.length === 1);
    expect(r.connected).toBe(true);
    r.update(json("second"));
    await waitFor(async () => core((await listSessions(hub.latest()))[0])?.name === "second");
  });

  it("reconnects and re-registers after the hub goes away, reporting each connection", async () => {
    const dir = tempDir();
    const hub = inProcessHub(dir);
    const connected = vi.fn();
    const disconnected = vi.fn();
    const r = reporter(dir, hub.spawn, {
      spawnIntervalMs: 0,
      onConnected: connected,
      onDisconnected: disconnected,
    });
    r.update(json("a"));
    r.start();
    await waitFor(async () => (await listSessions(hub.latest())).length === 1);
    await waitFor(() => connected.mock.calls.length === 1);
    const first = hub.latest()!;
    await first.stop();
    await waitFor(() => disconnected.mock.calls.length === 1);
    expect(r.connected).toBe(false);
    await waitFor(
      async () => hub.latest() !== first && (await listSessions(hub.latest())).length === 1,
    );
    await waitFor(() => connected.mock.calls.length === 2);
  });

  it("removes its card at once on quit, and reports the disconnection", async () => {
    const dir = tempDir();
    const hub = inProcessHub(dir);
    const disconnected = vi.fn();
    const r = reporter(dir, hub.spawn, { onDisconnected: disconnected });
    r.update(json("a"));
    r.start();
    await waitFor(async () => (await listSessions(hub.latest())).length === 1);
    await waitFor(() => r.connected);
    r.close("quit");
    expect(disconnected).toHaveBeenCalledTimes(1);
    await waitFor(async () => (await listSessions(hub.latest())).length === 0);
  });

  it("throttles respawns and reports once when the hub never starts", async () => {
    const dir = tempDir();
    const spawn = vi.fn();
    const unavailable = vi.fn();
    const r = reporter(dir, spawn, {
      unavailableAfter: 3,
      onUnavailable: unavailable,
      spawnIntervalMs: 60_000,
    });
    r.update(json("a"));
    r.start();
    await waitFor(() => unavailable.mock.calls.length === 1);
    await sleep(150);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(r.connected).toBe(false);
  });

  it("tells why a hub refused it, never counts as connected, and backs off", async () => {
    const dir = tempDir();
    const path = hubPaths(dir).socket;
    const hub = await scriptedHub(path, (socket) =>
      socket.end(
        encode({
          type: "refused",
          version: PROTOCOL_VERSION + 1,
          error: "Restart that Pi session.",
        }),
      ),
    );
    const refused = vi.fn();
    const connected = vi.fn();
    const unavailable = vi.fn();
    const r = reporter(dir, vi.fn(), {
      onRefused: refused,
      onConnected: connected,
      onUnavailable: unavailable,
      unavailableAfter: 1,
      minDelayMs: 20,
      maxDelayMs: 200,
    });
    r.update(json("a"));
    r.start();
    await waitFor(() => refused.mock.calls.length >= 3);
    expect(refused).toHaveBeenCalledWith("Restart that Pi session.");
    expect(connected).not.toHaveBeenCalled();
    expect(unavailable).not.toHaveBeenCalled();
    // Backoff grows between refusals rather than spinning on a reconnect loop.
    const before = hub.read.length;
    await sleep(150);
    expect(hub.read.length - before).toBeLessThan(5);
  });

  it("ignores a welcome for another protocol", async () => {
    const dir = tempDir();
    await scriptedHub(hubPaths(dir).socket, (socket) =>
      socket.write(encode({ type: "welcome", version: PROTOCOL_VERSION - 1 })),
    );
    const connected = vi.fn();
    const r = reporter(dir, vi.fn(), { onConnected: connected });
    r.update(json("a"));
    r.start();
    await sleep(100);
    expect(connected).not.toHaveBeenCalled();
  });

  it("runs commands and keeps each result within the line limit", async () => {
    const dir = tempDir();
    const results: Array<Record<string, unknown>> = [];
    await scriptedHub(hubPaths(dir).socket, (socket) => {
      socket.write(encode({ type: "welcome", version: PROTOCOL_VERSION }));
      socket.write(encode({ type: "command", id: 1, command: "action", action: "a.small" }));
      socket.write(encode({ type: "command", id: 2, command: "action", action: "a.huge" }));
      socket.write(encode({ type: "command", id: 3, command: "action", action: "a.fails" }));
      socket.write(`${JSON.stringify({ type: "command", id: 4, command: "answer" })}\n`);
      const decoder = new LineDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const decoded of decoder.push(chunk))
          if (decoded.ok && (decoded.value as { type?: string }).type === "result")
            results.push(decoded.value as Record<string, unknown>);
      });
    });
    const r = reporter(dir, vi.fn(), {
      onCommand: async (request) => {
        if (request.command !== "action") return undefined;
        if (request.action === "a.small") return { text: "é" };
        // Under the limit in UTF-16 units, over it in UTF-8 bytes.
        if (request.action === "a.huge") return "€".repeat(MAX_LINE_BYTES / 2);
        throw new Error("x".repeat(2_000));
      },
    });
    r.update(json("a"));
    r.start();
    await waitFor(() => results.length === 4);
    const byId = new Map(results.map((result) => [result.id, result]));
    expect(byId.get(1)).toEqual({ type: "result", id: 1, ok: true, data: { text: "é" } });
    expect(byId.get(2)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^The answer is too large to send to the dashboard/),
    });
    expect((byId.get(3)!.error as string).length).toBeLessThanOrEqual(500);
    expect(byId.get(4)).toEqual({
      type: "result",
      id: 4,
      ok: false,
      error: "This session cannot do that.",
    });
  });
});
