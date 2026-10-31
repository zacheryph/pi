import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getAgentDir,
  getSubagentsService,
  loadWorktreesConfig,
  pruneWorktrees,
  findPreservedWorktrees,
  findUnmergedRescueBranches,
} = vi.hoisted(() => ({
  getAgentDir: vi.fn((): string => "/fake/agent-dir"),
  getSubagentsService: vi.fn(),
  loadWorktreesConfig: vi.fn(() => ({ worktreeAgents: ["Explore"] })),
  pruneWorktrees: vi.fn(),
  findPreservedWorktrees: vi.fn((): string[] => []),
  findUnmergedRescueBranches: vi.fn((): string[] => []),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir }));
vi.mock("../../pi-subagents/src/service/service.ts", () => ({ getSubagentsService }));
vi.mock("#src/config", () => ({ loadWorktreesConfig }));
vi.mock("#src/worktree", () => ({ pruneWorktrees }));
vi.mock("#src/preserved", () => ({
  findPreservedWorktrees,
  formatPreservedNotice: (paths: readonly string[]) =>
    `notice for ${paths.join(", ")}`,
}));
vi.mock("#src/rescue-branches", () => ({
  findUnmergedRescueBranches,
  formatRescueBranchNotice: (branches: readonly string[]) =>
    `branch notice for ${branches.join(", ")}`,
}));

import { ActiveWorktrees } from "#src/active-worktrees";
import piSubagentsWorktrees from "#src/index";
import { WorktreeWorkspaceProvider } from "#src/workspace-provider";

type SessionHandler = (event: unknown, ctx: unknown) => void;

/** Build a fake ExtensionAPI capturing event handlers. */
function fakePi() {
  const handlers = new Map<string, SessionHandler>();
  return {
    pi: {
      on: vi.fn((event: string, cb: SessionHandler) => handlers.set(event, cb)),
      registerCommand: vi.fn(),
    },
    handlers,
  };
}

/** Build an ExtensionContext double exposing only what the handler reads. */
function fakeCtx(hasUI = true, sessionId = "session-1") {
  const notify = vi.fn();
  return {
    ctx: { hasUI, ui: { notify }, sessionManager: { getSessionId: () => sessionId } },
    notify,
  };
}

describe("piSubagentsWorktrees extension entry", () => {
  beforeEach(() => {
    getSubagentsService.mockReset();
    pruneWorktrees.mockClear();
    getAgentDir.mockClear();
    loadWorktreesConfig.mockClear();
    findPreservedWorktrees.mockClear();
    findPreservedWorktrees.mockReturnValue([]);
    findUnmergedRescueBranches.mockClear();
    findUnmergedRescueBranches.mockReturnValue([]);
  });

  /** Register the extension against an available subagents service. */
  function startWithService() {
    getSubagentsService.mockReturnValue({
      registerWorkspaceProvider: vi.fn(() => vi.fn()),
    });
    const { pi, handlers } = fakePi();
    piSubagentsWorktrees(pi as never);
    return { pi, handlers };
  }

  it("registers a worktree provider with the session's own service at session_start", () => {
    const unregister = vi.fn();
    const registerWorkspaceProvider = vi.fn((_provider: unknown) => unregister);
    getSubagentsService.mockReturnValue({ registerWorkspaceProvider });

    const { pi, handlers } = fakePi();
    piSubagentsWorktrees(pi as never);

    expect(loadWorktreesConfig).toHaveBeenCalledWith(
      "/fake/agent-dir",
      process.cwd(),
    );
    expect(pruneWorktrees).toHaveBeenCalledWith(process.cwd());
    expect(registerWorkspaceProvider).not.toHaveBeenCalled();

    handlers.get("session_start")?.(
      { type: "session_start" },
      fakeCtx(false, "child-7").ctx,
    );

    expect(getSubagentsService).toHaveBeenCalledWith("child-7");
    expect(registerWorkspaceProvider).toHaveBeenCalledTimes(1);
    expect(registerWorkspaceProvider.mock.calls[0][0]).toBeInstanceOf(
      WorktreeWorkspaceProvider,
    );
  });

  it("replaces its own registration when the session starts again", () => {
    const first = vi.fn();
    const second = vi.fn();
    const registerWorkspaceProvider = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    getSubagentsService.mockReturnValue({ registerWorkspaceProvider });

    const { pi, handlers } = fakePi();
    piSubagentsWorktrees(pi as never);
    handlers.get("session_start")?.({ type: "session_start" }, fakeCtx(false).ctx);
    handlers.get("session_start")?.({ type: "session_start" }, fakeCtx(false).ctx);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(registerWorkspaceProvider).toHaveBeenCalledTimes(2);
  });

  it("runs children unisolated when the session has no subagents service", () => {
    getSubagentsService.mockReturnValue(undefined);

    const { pi, handlers } = fakePi();
    expect(() => piSubagentsWorktrees(pi as never)).not.toThrow();
    expect(() =>
      handlers.get("session_start")?.({ type: "session_start" }, fakeCtx().ctx),
    ).not.toThrow();
    expect(() =>
      handlers.get("session_shutdown")?.({ type: "session_shutdown" }, fakeCtx().ctx),
    ).not.toThrow();
  });

  it("registers the preserved-worktree command", () => {
    const { pi } = startWithService();

    expect(pi.registerCommand).toHaveBeenCalledWith(
      "subagents-worktrees",
      expect.any(Object),
    );
  });

  it("unregisters the provider on session_shutdown", () => {
    const unregister = vi.fn();
    getSubagentsService.mockReturnValue({
      registerWorkspaceProvider: vi.fn(() => unregister),
    });

    const { pi, handlers } = fakePi();
    piSubagentsWorktrees(pi as never);
    handlers.get("session_start")?.({ type: "session_start" }, fakeCtx(false).ctx);

    expect(pi.on).toHaveBeenCalledWith(
      "session_shutdown",
      expect.any(Function),
    );
    expect(unregister).not.toHaveBeenCalled();
    handlers.get("session_shutdown")?.(
      { type: "session_shutdown" },
      fakeCtx().ctx,
    );
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  describe("preserved-worktree notice", () => {
    it("warns at session start about rescue worktrees left on disk", () => {
      findPreservedWorktrees.mockReturnValue([
        "/private/tmp/pi-agent-abc123-1f2e9c04",
      ]);
      const { handlers } = startWithService();
      const { ctx, notify } = fakeCtx();

      handlers.get("session_start")?.({ type: "session_start" }, ctx);

      expect(findPreservedWorktrees).toHaveBeenCalledWith(
        process.cwd(),
        expect.any(ActiveWorktrees),
      );
      expect(notify).toHaveBeenCalledWith(
        "notice for /private/tmp/pi-agent-abc123-1f2e9c04",
        "warning",
      );
    });

    it("stays silent when nothing was preserved", () => {
      const { handlers } = startWithService();
      const { ctx, notify } = fakeCtx();

      handlers.get("session_start")?.({ type: "session_start" }, ctx);

      expect(notify).not.toHaveBeenCalled();
    });

    it("does not scan in a session with no UI to notify", () => {
      findPreservedWorktrees.mockReturnValue([
        "/private/tmp/pi-agent-abc123-1f2e9c04",
      ]);
      const { handlers } = startWithService();
      const { ctx, notify } = fakeCtx(false);

      handlers.get("session_start")?.({ type: "session_start" }, ctx);

      expect(findPreservedWorktrees).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe("unmerged rescue branches at session start", () => {
    it("names the branches holding work nobody merged", () => {
      findUnmergedRescueBranches.mockReturnValue(["pi-agent-abc123"]);
      const { handlers } = startWithService();
      const { ctx, notify } = fakeCtx();

      handlers.get("session_start")?.({ type: "session_start" }, ctx);

      expect(findUnmergedRescueBranches).toHaveBeenCalledWith(process.cwd());
      expect(notify).toHaveBeenCalledWith(
        "branch notice for pi-agent-abc123",
        "warning",
      );
    });

    it("stays silent when every rescue branch has been merged", () => {
      const { handlers } = startWithService();
      const { ctx, notify } = fakeCtx();

      handlers.get("session_start")?.({ type: "session_start" }, ctx);

      expect(notify).not.toHaveBeenCalled();
    });

    it("reports each artifact in its own notice when both apply", () => {
      findPreservedWorktrees.mockReturnValue([
        "/private/tmp/pi-agent-abc123-1f2e9c04",
      ]);
      findUnmergedRescueBranches.mockReturnValue(["pi-agent-def456"]);
      const { handlers } = startWithService();
      const { ctx, notify } = fakeCtx();

      handlers.get("session_start")?.({ type: "session_start" }, ctx);

      expect(notify.mock.calls.map((call) => call[0])).toEqual([
        "notice for /private/tmp/pi-agent-abc123-1f2e9c04",
        "branch notice for pi-agent-def456",
      ]);
    });

    it("does not scan in a session with no UI to notify", () => {
      findUnmergedRescueBranches.mockReturnValue(["pi-agent-abc123"]);
      const { handlers } = startWithService();
      const { ctx, notify } = fakeCtx(false);

      handlers.get("session_start")?.({ type: "session_start" }, ctx);

      expect(findUnmergedRescueBranches).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });
  });
});
