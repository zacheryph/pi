import { describe, expect, it } from "vitest";
import { ActivityTracker, summarize } from "#src/activity";

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
    expect(summarize("todo", { action: "upsert", tasks: [{ subject: "x" }] })).toBeUndefined();
    expect(summarize("bash", null)).toBeUndefined();
    expect(summarize("bash", { command: "echo \u001b[31mred" })).toBe("echo  [31mred");
  });
});

describe("ActivityTracker", () => {
  it("lists calls newest first with duration, failure and running state", () => {
    let now = 1_000;
    const tracker = new ActivityTracker(() => now);
    expect(tracker.section()).toBeUndefined();
    tracker.start("a", "read", { path: "README.md" });
    now = 1_200;
    tracker.end("a", false);
    tracker.start("b", "bash", { command: "npm test" });
    now = 4_000;
    tracker.end("b", true);
    tracker.start("c", "bash", { command: "sleep 100" });
    expect(tracker.section()).toEqual([
      { tool: "bash", summary: "sleep 100", at: 4_000, running: true },
      { tool: "bash", summary: "npm test", at: 1_200, durationMs: 2_800, error: true },
      { tool: "read", summary: "README.md", at: 1_000, durationMs: 200 },
    ]);
    tracker.settle();
    expect(tracker.section()?.[0]).toEqual({ tool: "bash", summary: "sleep 100", at: 4_000 });
  });

  it("keeps the 12 most recent calls and ignores ends it never saw", () => {
    const tracker = new ActivityTracker(() => 1);
    for (let index = 0; index < 20; index += 1)
      tracker.start(`t${index}`, "read", { path: `f${index}` });
    tracker.end("missing", true);
    const section = tracker.section()!;
    expect(section).toHaveLength(12);
    expect(section[0]?.summary).toBe("f19");
  });
});
