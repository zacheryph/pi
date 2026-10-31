import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#src/config", () => ({ loadWorktreesConfig: () => ({ worktreeAgents: [] }) }));
vi.mock("#src/worktree", () => ({ pruneWorktrees: vi.fn(), discardWorktree: vi.fn() }));

import {
  publishSubagentsService,
  type SubagentsService,
  unpublishSubagentsService,
} from "../../pi-subagents/src/service/service.ts";
import piSubagentsWorktrees from "#src/index";

type Handler = (event: unknown, ctx: unknown) => void;

/** One session: a fake subagents service published under its id, plus this extension. */
function startSession(sessionId: string) {
  const register = vi.fn((_provider: unknown) => vi.fn());
  const service = { registerWorkspaceProvider: register } as unknown as SubagentsService;
  publishSubagentsService(service, sessionId);
  const handlers = new Map<string, Handler>();
  piSubagentsWorktrees({
    on: (event: string, cb: Handler) => handlers.set(event, cb),
    registerCommand: vi.fn(),
  } as never);
  const ctx = { hasUI: false, sessionManager: { getSessionId: () => sessionId } };
  handlers.get("session_start")?.({ type: "session_start" }, ctx);
  return { service, register, stop: () => handlers.get("session_shutdown")?.({}, ctx) };
}

const published: SubagentsService[] = [];

describe("provider registration across parent and child sessions", () => {
  afterEach(() => {
    for (const service of published.splice(0)) unpublishSubagentsService(service);
  });

  it("registers each session's provider with that session's own service", () => {
    const parent = startSession("parent");
    const child = startSession("child");
    published.push(parent.service, child.service);

    expect(parent.register).toHaveBeenCalledTimes(1);
    expect(child.register).toHaveBeenCalledTimes(1);
  });

  it("leaves the parent's registration in place when the child shuts down", () => {
    const parent = startSession("parent");
    const child = startSession("child");
    published.push(parent.service, child.service);
    const parentUnregister = parent.register.mock.results[0]?.value as ReturnType<typeof vi.fn>;
    const childUnregister = child.register.mock.results[0]?.value as ReturnType<typeof vi.fn>;

    child.stop();

    expect(childUnregister).toHaveBeenCalledTimes(1);
    expect(parentUnregister).not.toHaveBeenCalled();
  });
});
