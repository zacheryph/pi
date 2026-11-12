import { describe, expect, it, vi } from "vitest";
import { fakePi } from "#src/index";

describe("fakePi", () => {
  it("records registrations and drives handlers, tools and commands", async () => {
    const h = fakePi({ getSessionName: () => "named" });
    const seen: unknown[] = [];
    h.pi.on("session_start", (event: unknown, ctx: unknown) => {
      seen.push([event, ctx]);
    });
    h.pi.on("session_start", () => "second");
    h.api.registerTool({
      name: "echo",
      label: "Echo",
      description: "",
      parameters: {} as never,
      execute: async (id: string, params: unknown) => ({ id, params }),
    } as never);
    h.pi.registerCommand("x", { handler: async (args: string) => `ran ${args}` });
    h.api.appendEntry("kind", { a: 1 });

    expect(await h.emit("session_start", { reason: "startup" }, "ctx")).toBe("second");
    expect(seen).toEqual([[{ type: "session_start", reason: "startup" }, "ctx"]]);
    expect(await h.runTool("echo", { q: 1 })).toEqual({ id: "call-1", params: { q: 1 } });
    expect(await h.runCommand("x", "now")).toBe("ran now");
    expect(h.entries).toEqual([{ type: "custom", customType: "kind", data: { a: 1 } }]);
    expect(h.api.getSessionName()).toBe("named");
    expect(h.pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(() => h.tool("missing")).toThrow(/not registered/);
  });

  it("delivers bus events to listeners until they unsubscribe", () => {
    const h = fakePi();
    const listener = vi.fn();
    const off = h.api.events.on("a", listener);
    h.api.events.emit("a", 1);
    off();
    h.api.events.emit("a", 2);
    expect(listener.mock.calls).toEqual([[1]]);
    expect(h.events.published("a")).toEqual([1, 2]);
  });
});
