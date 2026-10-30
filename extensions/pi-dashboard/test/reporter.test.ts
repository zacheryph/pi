import { describe, expect, it, vi } from "vitest";
import { Hub } from "#src/hub/hub";
import { hubPaths } from "#src/protocol";
import { Reporter } from "#src/reporter";
import { get, onCleanup, snapshot, tempDir, waitFor } from "#test/helpers";

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

function reporter(dir: string, spawnHub: () => void, extra: Partial<ConstructorParameters<typeof Reporter>[0]> = {}) {
  const instance = new Reporter({ socketPath: hubPaths(dir).socket, spawnHub, minDelayMs: 10, maxDelayMs: 50, ...extra });
  onCleanup(() => instance.close("quit"));
  return instance;
}

const sessions = async (hub: Hub | undefined) => hub?.httpPort
  ? JSON.parse((await get(hub.httpPort, "/api/sessions")).body).sessions as Array<Record<string, unknown>>
  : [];

describe("Reporter", () => {
  it("spawns a hub when none listens, then says hello and sends updates", async () => {
    const dir = tempDir();
    const hub = inProcessHub(dir);
    const r = reporter(dir, hub.spawn);
    r.start(snapshot({ name: "first" }));
    await waitFor(async () => (await sessions(hub.latest()))[0]?.name === "first");
    expect(hub.spawn).toHaveBeenCalledTimes(1);
    r.update(snapshot({ name: "second" }));
    await waitFor(async () => (await sessions(hub.latest()))[0]?.name === "second");
  });

  it("reconnects and re-registers after the hub goes away", async () => {
    const dir = tempDir();
    const hub = inProcessHub(dir);
    const r = reporter(dir, hub.spawn, { spawnIntervalMs: 0 });
    r.start(snapshot());
    await waitFor(async () => (await sessions(hub.latest())).length === 1);
    const first = hub.latest()!;
    await first.stop();
    await waitFor(async () => hub.latest() !== first && (await sessions(hub.latest())).length === 1);
  });

  it("removes its card at once on quit", async () => {
    const dir = tempDir();
    const hub = inProcessHub(dir);
    const r = reporter(dir, hub.spawn);
    r.start(snapshot());
    await waitFor(async () => (await sessions(hub.latest())).length === 1);
    r.close("quit");
    await waitFor(async () => (await sessions(hub.latest())).length === 0);
  });

  it("throttles respawns and reports once when the hub never starts", async () => {
    const dir = tempDir();
    const spawn = vi.fn();
    const unavailable = vi.fn();
    const r = reporter(dir, spawn, { unavailableAfter: 3, onUnavailable: unavailable, spawnIntervalMs: 60_000 });
    r.start(snapshot());
    await waitFor(() => unavailable.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(r.connected).toBe(false);
  });
});
