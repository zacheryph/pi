import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParentPromptOptions, ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { SubagentRuntime } from "#src/runtime";
import type { SessionContext } from "#src/types";
import { makeModel } from "#test/helpers/make-model";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

const mockBuildParentSnapshot = vi.hoisted(() =>
  vi.fn<
    (
      ctx: SessionContext,
      inheritContext?: boolean,
      promptOptions?: ParentPromptOptions,
    ) => ParentSnapshot
  >(),
);

vi.mock("#src/lifecycle/parent-snapshot", () => ({
  buildParentSnapshot: mockBuildParentSnapshot,
}));

function makeSessionCtx(overrides?: Partial<SessionContext>): SessionContext {
  return {
    cwd: "/test/cwd",
    model: undefined,
    modelRegistry: { find: () => undefined, getAll: () => [] },
    getSystemPrompt: () => "test prompt",
    sessionManager: {
      getSessionFile: () => "/sessions/test.jsonl",
      getSessionId: () => "test-session-id",
      getBranch: () => [],
    },
    ...overrides,
  };
}

describe("SubagentRuntime session context", () => {
  it("starts empty, stores the context it is given, and clears it", () => {
    const runtime = new SubagentRuntime();
    expect(runtime.currentCtx).toBeUndefined();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    expect(runtime.currentCtx).toBe(ctx);
    runtime.clearSessionContext();
    expect(runtime.currentCtx).toBeUndefined();
  });
});

describe("SubagentRuntime context query methods", () => {
  beforeEach(() => {
    mockBuildParentSnapshot.mockReset();
  });

  it("buildSnapshot delegates to buildParentSnapshot with the current context and inheritContext flag", () => {
    const runtime = new SubagentRuntime();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    mockBuildParentSnapshot.mockReturnValueOnce(STUB_SNAPSHOT);
    const result = runtime.buildSnapshot(true);
    expect(mockBuildParentSnapshot).toHaveBeenCalledWith(ctx, true, undefined);
    expect(result).toBe(STUB_SNAPSHOT);
  });

  it("buildSnapshot passes false inheritContext correctly", () => {
    const runtime = new SubagentRuntime();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    mockBuildParentSnapshot.mockReturnValueOnce(STUB_SNAPSHOT);
    runtime.buildSnapshot(false);
    expect(mockBuildParentSnapshot).toHaveBeenCalledWith(ctx, false, undefined);
  });

  describe("prompt-options capture", () => {
    it("passes the latest captured options to buildParentSnapshot", () => {
      const runtime = new SubagentRuntime();
      const ctx = makeSessionCtx();
      runtime.setSessionContext(ctx);
      const options: ParentPromptOptions = { customPrompt: "You are a specialist." };
      runtime.setSystemPromptOptions(options);
      mockBuildParentSnapshot.mockReturnValueOnce(STUB_SNAPSHOT);

      runtime.buildSnapshot(false);

      expect(mockBuildParentSnapshot).toHaveBeenCalledWith(ctx, false, options);
    });

    it("keeps only the most recent capture", () => {
      const runtime = new SubagentRuntime();
      const ctx = makeSessionCtx();
      runtime.setSessionContext(ctx);
      const latest: ParentPromptOptions = { customPrompt: "second" };
      runtime.setSystemPromptOptions({ customPrompt: "first" });
      runtime.setSystemPromptOptions(latest);
      mockBuildParentSnapshot.mockReturnValueOnce(STUB_SNAPSHOT);

      runtime.buildSnapshot(false);

      expect(mockBuildParentSnapshot).toHaveBeenCalledWith(ctx, false, latest);
    });
  });

  it("getModelInfo returns model and modelRegistry from current context", () => {
    const runtime = new SubagentRuntime();
    const registry = { find: () => undefined, getAll: () => [], getAvailable: () => [] };
    const model = makeModel({ id: "claude-sonnet", name: "Claude Sonnet" });
    const ctx = makeSessionCtx({ model, modelRegistry: registry });
    runtime.setSessionContext(ctx);
    const info = runtime.getModelInfo();
    expect(info.parentModel).toBe(model);
    expect(info.modelRegistry).toBe(registry);
  });

  it("getModelInfo returns undefined parentModel when context model is undefined", () => {
    const runtime = new SubagentRuntime();
    const ctx = makeSessionCtx({ model: undefined });
    runtime.setSessionContext(ctx);
    const info = runtime.getModelInfo();
    expect(info.parentModel).toBeUndefined();
  });

  it("getSessionInfo returns session file and id from sessionManager", () => {
    const runtime = new SubagentRuntime();
    const ctx = makeSessionCtx({
      sessionManager: {
        getSessionFile: () => "/sessions/parent.jsonl",
        getSessionId: () => "session-42",
        getBranch: () => [],
      },
    });
    runtime.setSessionContext(ctx);
    const info = runtime.getSessionInfo();
    expect(info.parentSessionFile).toBe("/sessions/parent.jsonl");
    expect(info.parentSessionId).toBe("session-42");
  });

  it("getSessionInfo uses empty string when getSessionFile returns undefined", () => {
    const runtime = new SubagentRuntime();
    const ctx = makeSessionCtx({
      sessionManager: {
        getSessionFile: () => undefined,
        getSessionId: () => "session-99",
        getBranch: () => [],
      },
    });
    runtime.setSessionContext(ctx);
    const info = runtime.getSessionInfo();
    expect(info.parentSessionFile).toBe("");
    expect(info.parentSessionId).toBe("session-99");
  });
});
