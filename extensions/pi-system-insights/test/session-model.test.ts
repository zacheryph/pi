import { describe, expect, it } from "vitest";
import { isSessionModel } from "#surface";
import { buildSessionModel, type SessionSource } from "#src/session/model";

function source(overrides: Partial<SessionSource> = {}): SessionSource {
  return {
    cwd: "/work/api",
    sessionManager: { getSessionId: () => "session-a" },
    model: { provider: "anthropic", id: "opus", name: "Opus" },
    getContextUsage: () => ({ tokens: 1200, contextWindow: 200_000, percent: 0.6 }),
    ...overrides,
  };
}

const idle = { kind: "idle", since: 9 } as const;

describe("buildSessionModel", () => {
  it("collects the core fields", () => {
    const model = buildSessionModel({
      ctx: source(),
      name: "fix-auth",
      thinking: "high",
      status: { kind: "tool", tool: "bash", since: 9 },
      activity: [{ tool: "bash", at: 8, live: true }],
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 },
      startedAt: 5,
      piVersion: "1.5.2",
    });
    expect(model).toEqual({
      sessionId: "session-a",
      cwd: "/work/api",
      name: "fix-auth",
      model: { provider: "anthropic", id: "opus", name: "Opus" },
      thinking: "high",
      context: { tokens: 1200, window: 200_000, percent: 0.6 },
      status: { kind: "tool", tool: "bash", since: 9 },
      activity: [{ tool: "bash", at: 8, live: true }],
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 },
      startedAt: 5,
      piVersion: "1.5.2",
    });
    expect(isSessionModel(model)).toBe(true);
  });

  it("leaves out metadata Pi does not have yet, and stays valid", () => {
    const model = buildSessionModel({
      ctx: source({ model: undefined, getContextUsage: () => undefined }),
      status: idle,
      activity: [],
      startedAt: 5,
    });
    expect(model).toEqual({ sessionId: "session-a", cwd: "/work/api", status: idle, startedAt: 5 });
    expect(isSessionModel(model)).toBe(true);
  });

  it("keeps unknown context tokens as null, right after compaction", () => {
    const model = buildSessionModel({
      ctx: source({
        getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
      }),
      status: idle,
      startedAt: 5,
    });
    expect(model?.context).toEqual({ tokens: null, window: 200_000, percent: null });
    expect(isSessionModel(model)).toBe(true);
  });

  it("drops malformed metadata rather than publishing an invalid model", () => {
    const model = buildSessionModel({
      ctx: source({
        cwd: undefined as unknown as string,
        model: { provider: "", id: "x", name: 7 },
        getContextUsage: () => ({ tokens: NaN, contextWindow: Infinity, percent: -1 }),
      }),
      name: "  \n ",
      thinking: 3,
      status: idle,
      startedAt: 5,
      piVersion: "",
    });
    expect(model).toEqual({ sessionId: "session-a", cwd: "", status: idle, startedAt: 5 });
    expect(isSessionModel(model)).toBe(true);

    const partial = buildSessionModel({
      ctx: source({
        model: { provider: "p", id: "m", name: undefined },
        getContextUsage: () => ({ tokens: -3, contextWindow: 1000, percent: Infinity }),
      }),
      name: "a\u001b[2Jb",
      status: idle,
      startedAt: 5,
    });
    expect(partial).toMatchObject({
      name: "a [2Jb",
      model: { provider: "p", id: "m" },
      context: { tokens: null, window: 1000, percent: null },
    });
    expect(partial?.model).not.toHaveProperty("name");
    expect(isSessionModel(partial)).toBe(true);
  });

  it("has nothing to show without a session id", () => {
    expect(
      buildSessionModel({
        ctx: source({ sessionManager: { getSessionId: () => "" } }),
        status: idle,
        startedAt: 5,
      }),
    ).toBeUndefined();
  });
});
