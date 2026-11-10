import { service } from "../../../packages/pi-session-tree/src/index.ts";
import { WORK_PARENT_SERVICE, type WorkParent } from "../../../packages/pi-work/src/index.ts";

/** Where `ask` sends questions in one session. */
export type AskRoute =
  /** A delegated session: the delegator is told, and the session waits on a question item. */
  { kind: "parent"; parent: WorkParent } | { kind: "user"; mode: "tui" | "rpc" } | { kind: "none" };

/**
 * A session whose delegator offers `work:v1`'s parent link (pi-subagent does for every child,
 * before the child's extensions bind) asks that delegator. Any other session with a terminal asks
 * the user, as it always has.
 */
export function resolveRoute(ctx: {
  hasUI: boolean;
  mode: string;
  sessionManager: { getSessionId(): string };
}): AskRoute {
  const parent = service<WorkParent>(ctx.sessionManager.getSessionId(), WORK_PARENT_SERVICE);
  if (parent && typeof parent.question === "function") return { kind: "parent", parent };
  if (ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc"))
    return { kind: "user", mode: ctx.mode };
  return { kind: "none" };
}
