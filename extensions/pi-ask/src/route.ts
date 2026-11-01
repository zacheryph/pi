import { service } from "../../../packages/pi-session-tree/src/index.ts";

/**
 * The service a delegating extension provides under a child session's id so
 * that `ask` reaches the child's parent agent instead of the user. pi-subagent
 * provides it for every subagent before the child's extensions bind.
 */
export const ASK_ROUTE_SERVICE = "ask:route";

export interface AskParentRoute {
  /** Record the question against the child's run; the parent answers by resuming it. */
  record(question: string): void;
}

/** Where `ask` sends questions in one session. */
export type AskRoute =
  | { kind: "parent"; parent: AskParentRoute }
  | { kind: "user"; mode: "tui" | "rpc" }
  | { kind: "none" };

export function resolveRoute(ctx: {
  hasUI: boolean;
  mode: string;
  sessionManager: { getSessionId(): string };
}): AskRoute {
  const parent = service<AskParentRoute>(ctx.sessionManager.getSessionId(), ASK_ROUTE_SERVICE);
  if (parent && typeof parent.record === "function") return { kind: "parent", parent };
  if (ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc"))
    return { kind: "user", mode: ctx.mode };
  return { kind: "none" };
}
