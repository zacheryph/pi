import { describe, it, expect } from "vitest";
import { FeedDecoder } from "../server/feed.ts";
import { feedPath } from "../server/path.ts";

describe("private session feed", () => {
  it("separates sessions even in the same cwd", () => {
    expect(feedPath("session-a")).not.toBe(feedPath("session-b"));
    expect(feedPath("../../escape")).not.toContain("..");
  });
  it("decodes split/coalesced full snapshots including waiting agents", () => {
    const decoder = new FeedDecoder();
    const state = {
      version: 1,
      sessionId: "a",
      subagents: {
        agents: [
          { id: "b", type: "explore", description: "CI", state: "waiting", since: 1, note: "CI" },
        ],
      },
    };
    const line = JSON.stringify(state);
    expect(decoder.push(line.slice(0, 10))).toEqual([]);
    expect(decoder.push(line.slice(10) + "\n" + line + "\n")).toEqual([state, state]);
  });
  it("rejects incompatible or oversized frames and never reuses partial reconnect state", () => {
    expect(() => new FeedDecoder().push('{"version":2}\n')).toThrow();
    expect(() => new FeedDecoder().push("x".repeat(1024 * 1024 + 1))).toThrow("too large");
    const old = new FeedDecoder();
    old.push('{"version":');
    expect(new FeedDecoder().push('{"version":1,"sessionId":"fresh"}\n')).toEqual([
      { version: 1, sessionId: "fresh" },
    ]);
  });
});
