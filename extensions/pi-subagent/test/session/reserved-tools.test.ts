import { describe, expect, it } from "vitest";
import { reservedToolRefusal, reservedToolsExtension } from "#src/session/reserved-tools";

describe("reservedToolRefusal", () => {
  it("blocks a reserved tool with a reason that sends the work to a worker", () => {
    expect(reservedToolRefusal({ toolName: "bash" }, ["edit", "bash"], "orchestrate")).toEqual({
      block: true,
      reason:
        "bash is reserved for workers: as orchestrate you coordinate and delegate. " +
        "Start a worker with subagent_start, or message one with subagent_send, to do this work.",
    });
  });

  it("lets every other tool through", () => {
    expect(reservedToolRefusal({ toolName: "read" }, ["edit", "bash"], "orchestrate")).toBe(
      undefined,
    );
  });
});

describe("reservedToolsExtension", () => {
  it("refuses the session's calls to reserved tools only", () => {
    const handlers = new Map<string, Function>();
    void reservedToolsExtension("orchestrate", ["write"])({
      on: (name: string, fn: Function) => handlers.set(name, fn),
    } as never);
    expect([...handlers.keys()]).toEqual(["tool_call"]);
    expect(handlers.get("tool_call")?.({ toolName: "write" })).toMatchObject({ block: true });
    expect(handlers.get("tool_call")?.({ toolName: "read" })).toBeUndefined();
  });
});
