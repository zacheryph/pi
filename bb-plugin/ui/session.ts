// Reads shared by every slot. The live query dedupes per input and refreshes
// when the server invalidates the thread's tag, so many slots cost one request.
import {
  experimental_useAppPanel,
  experimental_useRpcQuery,
  useComposer,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useState } from "react";
import {
  rpcContract,
  type SessionSnapshot,
  type SessionSummary,
  type SurfaceRequest,
} from "../contract.ts";

export function useSession(threadId: string | null | undefined): SessionSnapshot | null {
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "snapshot",
    input: { threadId: threadId ?? "-" },
    enabled: !!threadId,
  });
  return threadId ? (query.data?.snapshot ?? null) : null;
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

/** Opens the Pi tab in the side panel of the surface the component renders in. */
export function useOpenSessionTab(): () => boolean {
  const panel = experimental_useAppPanel();
  return useCallback(() => panel.openTab({ tab: SESSION_TAB }), [panel]);
}

export type Loaded<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; value: T }
  | { state: "error"; message: string };

/** One on-demand request to the thread's session (a stash preview, a task's history). */
export function useSessionRequest<T>(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [loaded, setLoaded] = useState<Record<string, Loaded<T>>>({});
  const load = useCallback(
    (key: string, request: SurfaceRequest) => {
      setLoaded((current) => ({ ...current, [key]: { state: "loading" } }));
      rpc.call("request", { threadId, request }).then(
        ({ data }) =>
          setLoaded((current) => ({ ...current, [key]: { state: "done", value: data as T } })),
        (error: unknown) =>
          setLoaded((current) => ({
            ...current,
            [key]: {
              state: "error",
              message: error instanceof Error ? error.message : String(error),
            },
          })),
      );
    },
    [rpc, threadId],
  );
  const forget = useCallback((key: string) => {
    setLoaded((current) => {
      const { [key]: _gone, ...rest } = current;
      return rest;
    });
  }, []);
  return { loaded, load, forget };
}
