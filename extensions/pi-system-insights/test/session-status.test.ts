import { describe, expect, it } from "vitest";
import { StatusTracker } from "#src/session/status";

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

  it("waits on an open form below a native dialog, above everything else", () => {
    const { status } = tracker();
    status.agentStart();
    status.toolStart("a", "ask_user");
    status.compactStart();
    expect(status.setForm({ title: "Pick a database" })).toBe(true);
    expect(status.current()).toMatchObject({ kind: "waiting", title: "Pick a database" });
    status.promptStart("Allow network?");
    expect(status.current()).toMatchObject({ kind: "waiting", title: "Allow network?" });
    status.promptEnd();
    expect(status.current()).toMatchObject({ kind: "waiting", title: "Pick a database" });
    expect(status.setForm(undefined)).toBe(true);
    expect(status.current().kind).toBe("compacting");
  });

  it("keeps waiting on a form after Pi settles: the form's owner closes it", () => {
    const { status } = tracker();
    status.setForm({});
    status.settled();
    expect(status.current()).toMatchObject({ kind: "waiting" });
    expect(status.current()).not.toHaveProperty("title");
  });

  it("keeps since when an event does not change the status, and says so", () => {
    const { status, tick } = tracker();
    status.agentStart();
    tick(50);
    expect(status.agentStart()).toBe(false);
    expect(status.toolEnd("never-started")).toBe(false);
    expect(status.setForm(undefined)).toBe(false);
    expect(status.current().since).toBe(0);
  });

  it("clears tools left running and compaction when Pi settles", () => {
    const { status } = tracker();
    status.agentStart();
    status.toolStart("a", "bash");
    status.compactStart();
    status.settled();
    expect(status.current().kind).toBe("idle");
  });

  it("cleans titles and tool names", () => {
    const { status } = tracker();
    status.toolStart("a", "  \u001b[31m ");
    expect(status.current()).toMatchObject({ kind: "tool", tool: "[31m" });
    status.toolStart("b", "\n");
    expect(status.current()).toMatchObject({ kind: "tool", tool: "tool" });
    status.promptStart("  Pick\none ");
    expect(status.current()).toMatchObject({ kind: "waiting", title: "Pick one" });
    status.promptStart("   ");
    expect(status.current()).toEqual({ kind: "waiting", since: 0 });
  });
});
