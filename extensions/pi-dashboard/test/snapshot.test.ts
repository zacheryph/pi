import { describe, expect, it } from "vitest";
import { agentName, buildSnapshot, cleanText, type SnapshotSource } from "#src/snapshot";

const profile = (name: unknown) => ({ type: "custom", customType: "pi-subagents:main-agent-profile", data: { version: 1, profile: { name } } });

function source(branch: unknown[] = [], overrides: Partial<SnapshotSource> = {}): SnapshotSource {
  return {
    cwd: "/work/api",
    sessionManager: { getSessionId: () => "session-a", getBranch: () => branch },
    model: { provider: "anthropic", id: "claude-opus", name: "Opus" },
    getContextUsage: () => ({ tokens: 1200, contextWindow: 200_000, percent: 0.6 }),
    ...overrides,
  };
}

describe("agentName", () => {
  it("uses the latest main-agent profile on the branch", () => {
    expect(agentName([profile("explorer"), { type: "message" }, profile("orchestrator")])).toBe("orchestrator");
  });

  it("ignores other entries and malformed names", () => {
    expect(agentName([{ type: "custom", customType: "other", data: { profile: { name: "x" } } }, profile(42), null])).toBeUndefined();
  });
});

describe("cleanText", () => {
  it("collapses control characters and whitespace, and caps length", () => {
    expect(cleanText("  fix\u001b[31m\nauth\t ")).toBe("fix [31m auth");
    expect(cleanText("x".repeat(500))).toHaveLength(200);
    expect(cleanText("   ")).toBeUndefined();
    expect(cleanText(7)).toBeUndefined();
  });
});

describe("buildSnapshot", () => {
  it("collects the core fields", () => {
    const result = buildSnapshot({
      id: "7", pid: 7, startedAt: 5, piVersion: "1.4.0", ctx: source([profile("orchestrator")]),
      sessionName: "fix-auth", thinking: "high", status: { kind: "tool", tool: "bash", since: 9 },
    });
    expect(result).toEqual({
      id: "7", pid: 7, sessionId: "session-a", cwd: "/work/api", name: "fix-auth", agent: "orchestrator",
      model: { provider: "anthropic", id: "claude-opus", name: "Opus" }, thinking: "high",
      status: { kind: "tool", tool: "bash", since: 9 },
      context: { tokens: 1200, window: 200_000, percent: 0.6 }, startedAt: 5, piVersion: "1.4.0",
    });
  });

  it("omits what the session does not have, and cleans prompt titles", () => {
    const result = buildSnapshot({
      id: "7", pid: 7, startedAt: 5, ctx: source([], { model: undefined, getContextUsage: () => undefined }),
      sessionName: " ", status: { kind: "waiting", title: "Allow\nbash?", since: 3 },
    });
    expect(result).toEqual({
      id: "7", pid: 7, sessionId: "session-a", cwd: "/work/api",
      status: { kind: "waiting", title: "Allow bash?", since: 3 }, startedAt: 5,
    });
  });
});
