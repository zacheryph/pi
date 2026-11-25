// Reads shared by every slot. The live query dedupes per input and refreshes
// when the server invalidates the thread's tag, so many slots cost one request.
import {
  experimental_useAppPanel,
  experimental_useRpcQuery,
  useComposer,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { useCallback } from "react";
import {
  rpcContract,
  type DeliverySnapshot,
  type SessionSummary,
  type SnapshotResult,
  type SurfaceRequest,
} from "../contract.ts";
import type { RunAction } from "./surface.tsx";

const NONE: SnapshotResult = { snapshot: null, source: null, connected: false };

/** The thread's snapshot and where it comes from (a running Pi, a saved copy, a fixture). */
export function useSessionResult(threadId: string | null | undefined): SnapshotResult {
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "snapshot",
    input: { threadId: threadId ?? "-" },
    enabled: !!threadId,
  });
  return threadId ? (query.data ?? NONE) : NONE;
}

export function useSession(threadId: string | null | undefined): DeliverySnapshot | null {
  return useSessionResult(threadId).snapshot;
}

export function useSessions(): SessionSummary[] {
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "sessions",
    input: null,
  });
  return query.data?.sessions ?? [];
}

/** The thread whose composer mounted the calling component, if it is a thread composer. */
export function useComposerThread(): string | null {
  const { scope } = useComposer();
  return scope.kind === "thread" ? scope.threadId : null;
}

export const SESSION_TAB = {
  id: "session",
  context: { kind: "thread" },
  availability: "fixed",
} as const;

/** The tab beside the Pi tab with the session's pull requests, worktrees and stash. */
export const GIT_TAB = {
  id: "git",
  context: { kind: "thread" },
  availability: "fixed",
} as const;

/** Opens the Pi tab in the side panel of the surface the component renders in. */
export function useOpenSessionTab(): () => boolean {
  const panel = experimental_useAppPanel();
  return useCallback(() => panel.openTab({ tab: SESSION_TAB }), [panel]);
}

/** Opens the Pi Git tab (pull requests, worktrees, stash) in the side panel. */
export function useOpenGitTab(): () => boolean {
  const panel = experimental_useAppPanel();
  return useCallback(() => panel.openTab({ tab: GIT_TAB }), [panel]);
}

/**
 * Runs an action on the thread's session (an explorer's `loadDetail`, say). Undefined for a
 * saved snapshot: no Pi runs for the thread to ask.
 */
export function useRunAction(
  threadId: string,
  source: SnapshotResult["source"],
): RunAction | undefined {
  const rpc = useRpc<typeof rpcContract>();
  const run = useCallback<RunAction>(
    async (action, args) => {
      // zod's JSON type is mutable; the arguments are JSON either way.
      const request = { action, args } as SurfaceRequest;
      return (await rpc.call("request", { threadId, request })).value;
    },
    [rpc, threadId],
  );
  return source === "live" || source === "fixture" ? run : undefined;
}
