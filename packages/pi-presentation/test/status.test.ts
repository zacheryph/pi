import { describe, expect, it } from "vitest";
import { StatusTracker } from "#src/status";

function tracker() {
  let now = 0;
  const status = new StatusTracker(() => now);
  return {
    status,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe("StatusTracker", () => {
  it("moves from idle to working to a tool and back", () => {
    const { status, tick } = tracker();
    expect(status.current()).toEqual({ kind: "idle", since: 0 });
    tick(10);
    status.agentStart();
    expect(status.current()).toEqual({ kind: "working", since: 10 });
    tick(10);
    status.toolStart("a", "bash");
    expect(status.current()).toEqual({ kind: "tool", tool: "bash", since: 20 });
    tick(10);
    status.toolEnd("a");
    expect(status.current()).toEqual({ kind: "working", since: 30 });
    tick(10);
    status.settled();
    expect(status.current()).toEqual({ kind: "idle", since: 40 });
  });

  it("shows the most recent of parallel tools", () => {
    const { status } = tracker();
    status.agentStart();
    status.toolStart("a", "read");
    status.toolStart("b", "grep");
    expect(status.current()).toMatchObject({ kind: "tool", tool: "grep" });
    status.toolEnd("b");
    expect(status.current()).toMatchObject({ kind: "tool", tool: "read" });
  });

  it("puts a waiting prompt above compaction and tools", () => {
    const { status } = tracker();
    status.agentStart();
    status.toolStart("a", "bash");
    status.compactStart();
    expect(status.current().kind).toBe("compacting");
    status.promptStart("Overwrite plan.md?");
    expect(status.current()).toMatchObject({ kind: "waiting", title: "Overwrite plan.md?" });
    status.promptEnd();
    status.compactEnd();
    expect(status.current()).toMatchObject({ kind: "tool", tool: "bash" });
  });

  it("keeps since when an event does not change the status", () => {
    const { status, tick } = tracker();
    status.agentStart();
    tick(50);
    status.agentStart();
    status.toolEnd("never-started");
    expect(status.current().since).toBe(0);
  });

  it("clears tools left running when Pi settles", () => {
    const { status } = tracker();
    status.agentStart();
    status.toolStart("a", "bash");
    status.settled();
    expect(status.current().kind).toBe("idle");
  });
});
