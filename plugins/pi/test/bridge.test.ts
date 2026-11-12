import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakePi } from "pi-test-helpers";
import bridge from "../../../integrations/paseo/pi-extension.ts";
import { serveFeed } from "../server/host.ts";
vi.mock("../server/host.ts", () => ({ serveFeed: vi.fn() }));
const stop = vi.fn(async () => {});
const context = (mode = "rpc", sessionId = "s1") => ({
  mode,
  sessionManager: { getSessionId: () => sessionId },
  ui: { notify: vi.fn() },
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(serveFeed).mockResolvedValue(stop);
});
describe("opt-in Pi bridge", () => {
  it("serves RPC only without spawning or reporting a dashboard", async () => {
    const fake = fakePi();
    bridge(fake.api);
    await fake.emit("session_start", {}, context("tui"));
    expect(serveFeed).not.toHaveBeenCalled();
    await fake.emit("session_start", {}, context());
    expect(serveFeed).toHaveBeenCalledTimes(1);
    expect(fake.commands.size).toBe(0);
    expect(fake.tools.size).toBe(0);
    expect(fake.pi.sendMessage).not.toHaveBeenCalled();
    await fake.emit("session_shutdown", {});
    expect(stop).toHaveBeenCalledOnce();
  });
  it("clears the old branch on replacement and republishes producer state", async () => {
    const fake = fakePi();
    bridge(fake.api);
    fake.events.emit("todo:snapshot", { version: 1, revision: 1, tasks: [] });
    await fake.emit("session_start", {}, context());
    const read = vi.mocked(serveFeed).mock.calls[0]![1];
    expect(read()).toMatchObject({ sessionId: "s1", todos: { revision: 1 } });
    await fake.emit("session_shutdown", {});
    await fake.emit("session_start", {}, context("rpc", "s2"));
    expect(vi.mocked(serveFeed).mock.calls[1]![1]()).toMatchObject({
      sessionId: "s2",
      todos: undefined,
    });
    await fake.emit("session_shutdown", {});
  });
});
