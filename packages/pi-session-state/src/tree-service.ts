/**
 * tree-service.ts — one extension's service in the process-wide session tree.
 *
 * Every session's copy of an extension offers the same service under the same
 * name (see pi-session-tree). This owns the wiring each one repeats: follow
 * the session's children, provide the service on `session_start`, withdraw it
 * on `session_shutdown`, and reach the copy in the parent session.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  call,
  node,
  parentOf,
  provide,
  trackChildren,
  type CallResult,
  type SessionNode,
} from "../../pi-session-tree/src/index.ts";

export interface TreeService<T> {
  /** This session's id; undefined before `session_start` and after `session_shutdown`. */
  sessionId(): string | undefined;
  /** This session's registry node (parent link, pi-subagent agent id, handoff), if any. */
  node(): SessionNode | undefined;
  /**
   * Call this service in the parent session, synchronously (see
   * pi-session-tree's `call`). `missing` when there is no parent or it offers
   * nothing right now (reloading, or gone).
   */
  parent<R>(fn: (api: T) => R): CallResult<R>;
}

export interface TreeServiceOptions {
  /** Initialize synchronously in the same handler as provide, before Pi yields between handlers. */
  start?: (ctx: ExtensionContext) => void;
}

/**
 * Offer `api` under `name` for the current session, from `session_start` until
 * `session_shutdown`. Call from the extension factory: it also starts following
 * the session's children (`trackChildren`), which must happen before any spawn.
 *
 * After a reload, the new extension instance's provide replaces this one, and
 * this instance's withdraw then does nothing.
 */
export function treeService<T>(
  pi: Pick<ExtensionAPI, "on" | "events">,
  name: string,
  api: T,
  options: TreeServiceOptions = {},
): TreeService<T> {
  trackChildren(pi);
  let id: string | undefined;
  let withdraw: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    withdraw?.();
    id = ctx.sessionManager.getSessionId();
    withdraw = provide(id, name, api);
    options.start?.(ctx);
  });
  pi.on("session_shutdown", () => {
    withdraw?.();
    withdraw = undefined;
    id = undefined;
  });

  return {
    sessionId: () => id,
    node: () => (id === undefined ? undefined : node(id)),
    parent<R>(fn: (api: T) => R): CallResult<R> {
      const parent = id === undefined ? undefined : parentOf(id);
      if (parent === undefined) return { ok: false, reason: "missing" };
      return call<T, R>(parent, name, fn);
    },
  };
}
