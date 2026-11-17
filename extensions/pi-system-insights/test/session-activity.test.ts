import { describe, expect, it } from "vitest";
import { ActivityTracker, MAX_ACTIVITY, summarize } from "#src/session/activity";

describe("summarize", () => {
  it("shows a bash command's first line and file tools' paths, nothing else", () => {
    expect(summarize("bash", { command: "npm test -w api\necho done" })).toBe("npm test -w api");
    expect(summarize("bash", { command: "x".repeat(200) })).toHaveLength(80);
    expect(summarize("read", { path: "src/client/retry.ts", offset: 10 })).toBe(
      "src/client/retry.ts",
    );
    expect(summarize("edit", { file_path: `/very/${"deep/".repeat(30)}retry.ts` })).toMatch(
      /^….*retry\.ts$/,
    );
    expect(summarize("write", { path: "a.ts", content: "SECRET=1" })).toBe("a.ts");
    expect(summarize("todo_upsert", { tasks: [{ subject: "x" }] })).toBeUndefined();
    expect(summarize("bash", null)).toBeUndefined();
    expect(summarize("bash", { command: "echo \u001b[31mred" })).toBe("echo  [31mred");
  });
});

describe("ActivityTracker", () => {
  it("lists calls newest first with duration, failure and a live mark while running", () => {
    let now = 1_000;
    const tracker = new ActivityTracker(() => now);
    expect(tracker.list()).toBeUndefined();
    tracker.start("a", "read", { path: "README.md" });
    now = 1_200;
    tracker.end("a", false);
    tracker.start("b", "bash", { command: "npm test" });
    now = 4_000;
    tracker.end("b", true);
    tracker.start("c", "bash", { command: "sleep 100" });
    expect(tracker.list()).toEqual([
      { tool: "bash", summary: "sleep 100", at: 4_000, live: true },
      { tool: "bash", summary: "npm test", at: 1_200, durationMs: 2_800, error: true },
      { tool: "read", summary: "README.md", at: 1_000, durationMs: 200 },
    ]);
    tracker.settle();
    // Interrupted: no longer live, and no duration because it never finished.
    expect(tracker.list()?.[0]).toEqual({ tool: "bash", summary: "sleep 100", at: 4_000 });
    now = 9_000;
    tracker.end("c", false);
    expect(tracker.list()?.[0]).toEqual({ tool: "bash", summary: "sleep 100", at: 4_000 });
  });

  it(`keeps the ${MAX_ACTIVITY} most recent calls and ignores ends it never saw`, () => {
    const tracker = new ActivityTracker(() => 1);
    for (let index = 0; index < 20; index += 1)
      tracker.start(`t${index}`, "read", { path: `f${index}` });
    tracker.end("missing", true);
    const list = tracker.list()!;
    expect(list).toHaveLength(MAX_ACTIVITY);
    expect(list[0]?.summary).toBe("f19");
    expect(list.every((call) => call.live)).toBe(true);
  });

  it("returns copies, so a consumer cannot change the tracker", () => {
    const tracker = new ActivityTracker(() => 1);
    tracker.start("a", "read", { path: "a.ts" });
    const [first] = tracker.list()!;
    (first as { tool: string }).tool = "changed";
    expect(tracker.list()?.[0]?.tool).toBe("read");
  });
});
