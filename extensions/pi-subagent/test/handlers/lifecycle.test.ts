import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifecycleManager, LifecycleRuntime } from "#src/handlers/lifecycle";
import { SessionLifecycleHandler } from "#src/handlers/lifecycle";

describe("SessionLifecycleHandler", () => {
  let runtime: LifecycleRuntime;
  let manager: LifecycleManager;
  let mockSetSessionContext: ReturnType<typeof vi.fn<LifecycleRuntime["setSessionContext"]>>;
  let mockClearSessionContext: ReturnType<typeof vi.fn<LifecycleRuntime["clearSessionContext"]>>;
  let mockClearCompleted: ReturnType<typeof vi.fn<LifecycleManager["clearCompleted"]>>;
  let mockSuspend: ReturnType<typeof vi.fn<LifecycleManager["suspend"]>>;
  let mockDispose: ReturnType<typeof vi.fn<LifecycleManager["dispose"]>>;
  let mockDisposeNotifications: ReturnType<typeof vi.fn<() => void>>;
  let handler: SessionLifecycleHandler;

  beforeEach(() => {
    mockSetSessionContext = vi.fn();
    mockClearSessionContext = vi.fn();
    mockClearCompleted = vi.fn(() => Promise.resolve());
    mockSuspend = vi.fn();
    mockDispose = vi.fn(() => Promise.resolve());
    mockDisposeNotifications = vi.fn();

    runtime = {
      setSessionContext: mockSetSessionContext,
      clearSessionContext: mockClearSessionContext,
    };
    manager = {
      clearCompleted: mockClearCompleted,
      suspend: mockSuspend,
      dispose: mockDispose,
    };

    handler = new SessionLifecycleHandler(runtime, manager, mockDisposeNotifications);
  });

  describe("handleSessionStart", () => {
    it("sets session context and clears completed agents", async () => {
      const ctx = { cwd: "/some/path" };

      await handler.handleSessionStart({}, ctx);

      expect(runtime.setSessionContext).toHaveBeenCalledWith(ctx);
      expect(manager.clearCompleted).toHaveBeenCalled();
    });

    it("sets context before clearing completed", async () => {
      const callOrder: string[] = [];
      mockSetSessionContext.mockImplementation(() => {
        callOrder.push("setSessionContext");
      });
      mockClearCompleted.mockImplementation(() => {
        callOrder.push("clearCompleted");
        return Promise.resolve();
      });

      await handler.handleSessionStart({}, {});

      expect(callOrder).toEqual(["setSessionContext", "clearCompleted"]);
    });

    it("resolves only after the prior session's children have shut down", async () => {
      const cleared = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
      mockClearCompleted.mockReturnValue(cleared.promise);

      let settled = false;
      const pending = handler.handleSessionStart({}, {}).then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      cleared.resolve();
      await pending;
      expect(settled).toBe(true);
    });
  });

  describe("handleSessionBeforeSwitch", () => {
    it("clears completed agents", async () => {
      await handler.handleSessionBeforeSwitch();

      expect(manager.clearCompleted).toHaveBeenCalled();
    });

    it("resolves only after the cleared children have shut down", async () => {
      const cleared = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
      mockClearCompleted.mockReturnValue(cleared.promise);

      let settled = false;
      const pending = handler.handleSessionBeforeSwitch().then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      cleared.resolve();
      await pending;
      expect(settled).toBe(true);
    });
  });

  describe("handleSessionShutdown", () => {
    // Rewritten by roadmap step 12 (was: "calls cleanup in correct order" with `abortAll`). A
    // shutdown used to abort every agent, which cancelled the work waiting agents held. It now
    // suspends them: runs are interrupted and work is left open for the next start.
    it("calls cleanup in correct order", async () => {
      const callOrder: string[] = [];
      mockClearSessionContext.mockImplementation(() => {
        callOrder.push("clearSessionContext");
      });
      mockSuspend.mockImplementation(() => {
        callOrder.push("suspend");
      });
      mockDisposeNotifications.mockImplementation(() => {
        callOrder.push("disposeNotifications");
      });
      mockDispose.mockImplementation(() => {
        callOrder.push("dispose");
        return Promise.resolve();
      });

      await handler.handleSessionShutdown({ reason: "quit" });

      // The work items are silenced before the interruptions: a run cut short by the shutdown
      // must not close its item or send a message, because Pi cannot recall one already handed
      // to it, and the item left open is what the next start adopts or reports lost.
      expect(callOrder).toEqual([
        "clearSessionContext",
        "disposeNotifications",
        "suspend",
        "dispose",
      ]);
    });

    it("never stops or aborts an agent: it suspends them and leaves their work open", async () => {
      await handler.handleSessionShutdown({ reason: "reload" });
      expect(mockSuspend).toHaveBeenCalledTimes(1);
      expect(Object.keys(manager)).not.toContain("abortAll");
    });

    it.each(["quit", "new", "resume", "fork"])(
      "tells the children `quit` when the session ends with reason %s",
      async (reason) => {
        await handler.handleSessionShutdown({ reason });
        expect(mockDispose).toHaveBeenCalledWith("quit");
      },
    );

    it("tells the children `reload` when the session reloads, so their jobs can be kept", async () => {
      await handler.handleSessionShutdown({ reason: "reload" });
      expect(mockDispose).toHaveBeenCalledWith("reload");
    });

    it("tells the children `quit` when a delegated session reloads: its own subagents end with it", async () => {
      const delegated = new SessionLifecycleHandler(
        runtime,
        manager,
        mockDisposeNotifications,
        () => true,
      );
      await delegated.handleSessionShutdown({ reason: "reload" });
      expect(mockDispose).toHaveBeenCalledWith("quit");
    });

    it("resolves only after every child session has shut down", async () => {
      const disposed = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
      mockDispose.mockReturnValue(disposed.promise);

      let settled = false;
      const pending = handler.handleSessionShutdown().then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      disposed.resolve();
      await pending;
      expect(settled).toBe(true);
    });
  });
});
