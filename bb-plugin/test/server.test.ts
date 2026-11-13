import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionSnapshot } from "../contract.ts";
import { fixtureSnapshot } from "../fixture.ts";
import { createPlugin } from "../server.ts";

const THREAD = "thr_live";

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "4242",
    pid: 4242,
    sessionId: "session-a",
    cwd: "/work/api",
    status: { kind: "idle", since: 1 },
    startedAt: 1,
    ...overrides,
  };
}

const hosts: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "pi-surface" });
  await createPlugin({ graceMs: 30, helloTimeoutMs: 200, requestTimeoutMs: 500 })(bb);
  hosts.push({ dispose: () => harness.lifecycle.dispose() });
  const tokenFor = async (threadId: string) => {
    const entries = await harness.behavior.resolveProviderEnv("pi", {
      threadId,
      projectId: "proj_1",
      hostId: "host_1",
    });
    return entries.find((entry) => entry.name === "PI_BB_SURFACE_TOKEN")!.value as string;
  };
  const connect = async (threadId = THREAD, overrides: Partial<SessionSnapshot> = {}) => {
    const socket = await harness.behavior.experimental_openWebSocket("/session");
    await socket.receive(
      JSON.stringify({
        type: "hello",
        version: 1,
        threadId,
        token: await tokenFor(threadId),
        snapshot: snapshot(overrides),
      }),
    );
    return socket;
  };
  const read = (threadId = THREAD) =>
    harness.behavior.callRpc("snapshot", { threadId }) as Promise<{
      snapshot: SessionSnapshot | null;
      source: string | null;
      connected: boolean;
    }>;
  return { harness, tokenFor, connect, read };
}

const sentRequests = (socket: { sent: readonly (string | Uint8Array)[] }) =>
  socket.sent.map(
    (data) => JSON.parse(String(data)) as { type: string; id: number; request: unknown },
  );

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

  it("accepts a session's hello, serves its snapshot and follows updates", async () => {
    const { harness, connect, read } = await setup();
    expect(await read()).toEqual({ snapshot: null, source: null, connected: false });
    const socket = await connect();
    expect(await read()).toMatchObject({
      source: "live",
      connected: true,
      snapshot: { cwd: "/work/api" },
    });
    await socket.receive(
      JSON.stringify({ type: "update", snapshot: snapshot({ name: "renamed" }) }),
    );
    expect((await read()).snapshot?.name).toBe("renamed");
    expect(harness.inspection.experimental_rpcInvalidations).toContainEqual([
      `thread:${THREAD}`,
      "sessions",
    ]);
    expect(await harness.behavior.callRpc("sessions", null)).toMatchObject({
      sessions: [
        { threadId: THREAD, source: "live", connected: true, status: "idle", name: "renamed" },
      ],
    });
  });

  it("refuses a hello with another thread's token and ignores sessions that never say hello", async () => {
    const { harness, tokenFor, read } = await setup();
    const forged = await harness.behavior.experimental_openWebSocket("/session");
    await forged.receive(
      JSON.stringify({
        type: "hello",
        version: 1,
        threadId: THREAD,
        token: await tokenFor("thr_other"),
        snapshot: snapshot(),
      }),
    );
    expect(forged.closeCalls).toEqual([{ code: 4401, reason: "bad token" }]);
    const stale = await harness.behavior.experimental_openWebSocket("/session");
    await stale.receive(
      JSON.stringify({
        type: "hello",
        version: 9,
        threadId: THREAD,
        token: "x",
        snapshot: snapshot(),
      }),
    );
    expect(stale.closeCalls[0]?.code).toBe(4400);
    const silent = await harness.behavior.experimental_openWebSocket("/session");
    await silent.receive(JSON.stringify({ type: "update", snapshot: snapshot() }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(silent.closeCalls[0]?.code).toBe(4401);
    expect((await read()).snapshot).toBeNull();
  });

  it("forwards app requests to the session and returns its answer or error", async () => {
    const { harness, connect } = await setup();
    const socket = await connect();
    const preview = harness.behavior.callRpc("request", {
      threadId: THREAD,
      request: { command: "stash-preview", name: "notes" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [sent] = sentRequests(socket);
    expect(sent).toMatchObject({
      type: "request",
      request: { command: "stash-preview", name: "notes" },
    });
    await socket.receive(
      JSON.stringify({ type: "result", id: sent!.id, ok: true, data: { lines: ["a"] } }),
    );
    expect(await preview).toEqual({ data: { lines: ["a"] } });

    const history = harness.behavior.callRpc("request", {
      threadId: THREAD,
      request: { command: "todo-history", key: "gone" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = sentRequests(socket)[1]!;
    await socket.receive(
      JSON.stringify({ type: "result", id: second.id, ok: false, error: "No task" }),
    );
    await expect(history).rejects.toThrow("No task");

    await expect(
      harness.behavior.callRpc("request", {
        threadId: "thr_none",
        request: { command: "todo-history", key: "x" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps a disconnected session through the grace period, then drops it", async () => {
    const { connect, read } = await setup();
    const socket = await connect();
    await socket.close(1000, "replace");
    expect(await read()).toMatchObject({ source: "live", connected: false });
    const again = await connect(THREAD, { name: "after reload" });
    expect(await read()).toMatchObject({ connected: true, snapshot: { name: "after reload" } });
    await again.close();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await read()).snapshot).toBeNull();
  });

  it("lets the newest process for a thread take over", async () => {
    const { connect, read } = await setup();
    const first = await connect();
    await connect(THREAD, { pid: 5 });
    expect(first.closeCalls).toEqual([{ code: 4409, reason: "replaced" }]);
    expect((await read()).snapshot?.pid).toBe(5);
  });

  it("installs, lists and clears a fixture session from the CLI, and answers its requests", async () => {
    const { harness, read, connect } = await setup();
    expect((await harness.behavior.runCli(["fixture"])).exitCode).toBe(1);
    const installed = await harness.behavior.runCli(["fixture", "--thread", "thr_demo"]);
    expect(installed).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("thr_demo") });
    const result = await read("thr_demo");
    expect(result).toMatchObject({ source: "fixture", connected: true });
    expect(result.snapshot?.todos?.total).toBe(7);
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
    expect((await harness.behavior.runCli(["list"])).stdout).toContain("thr_demo  fixture");
    expect(
      await harness.behavior.callRpc("request", {
        threadId: "thr_demo",
        request: { command: "stash-preview", name: "review-notes" },
      }),
    ).toMatchObject({ data: { lines: expect.any(Array) } });

    await connect();
    expect((await harness.behavior.runCli(["fixture", "--thread", THREAD])).exitCode).toBe(1);
    expect((await harness.behavior.runCli(["clear", "--thread", THREAD])).exitCode).toBe(1);
    expect((await harness.behavior.runCli(["clear", "--thread", "thr_demo"])).exitCode).toBe(0);
    expect((await read("thr_demo")).snapshot).toBeNull();
  });

  it("shows a live session's open questionnaire as one form and sends the answer to Pi", async () => {
    const { harness, connect } = await setup();
    const [questionnaire] = fixtureSnapshot().questions!;
    const socket = await connect(THREAD, { questions: [questionnaire!] });
    expect(harness.inspection.pendingInteractions).toMatchObject([
      { threadId: THREAD, rendererId: "questionnaire", payload: { id: "fixture-ask-1" } },
    ]);
    harness.behavior.submitInteraction(harness.inspection.pendingInteractions[0]!.id, {
      answers: [
        { questionIndex: 0, optionIndexes: [1] },
        { questionIndex: 1, optionIndexes: [0, 2], text: " and 408 " },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sentRequests(socket).at(-1)).toMatchObject({
      request: {
        command: "answer",
        question: "fixture-ask-1",
        answer: {
          answers: [
            { questionIndex: 0, optionIndexes: [1] },
            { questionIndex: 1, optionIndexes: [0, 2], text: "and 408" },
          ],
        },
      },
    });
  });

  it("withdraws the form when Pi closes the questionnaire", async () => {
    const { harness, connect } = await setup();
    const [questionnaire] = fixtureSnapshot().questions!;
    const socket = await connect(THREAD, { questions: [questionnaire!] });
    expect(harness.inspection.pendingInteractions).toHaveLength(1);
    await socket.receive(JSON.stringify({ type: "update", snapshot: snapshot() }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
    expect(sentRequests(socket)).toHaveLength(0);
  });

  it("closes sessions when the plugin is disposed; pi-bb reconnects to the next generation", async () => {
    const { harness, connect } = await setup();
    const socket = await connect();
    await harness.lifecycle.dispose();
    hosts.length = 0;
    // bb closes the old generation's sockets with 1012, which pi-bb retries.
    expect(socket.closeCalls.map((call) => call.code)).toContain(1012);
  });
});
