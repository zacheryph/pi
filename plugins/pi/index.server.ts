import type { PluginServerContext } from "@getpaseo/plugin/server";
import { stateWatch } from "./shared/state.ts";
import { followFeed } from "./server/feed.ts";

export default function contribute(server: PluginServerContext) {
  server.handle(stateWatch, async ({ agentId }, context) => {
    const { paseo, signal } = context;
    const push = (event: Parameters<typeof context.push>[0]) => context.push(event);
    const agent = paseo.agents.ref(agentId);
    let stopFeed: (() => void) | undefined;
    let sessionId: string | undefined;
    let latest: Parameters<typeof push>[0] | undefined;
    let sending = false;
    let stopped = false;
    const send = (event: Parameters<typeof push>[0]) => {
      latest = event;
      if (sending || stopped || signal.aborted) return;
      sending = true;
      void (async () => {
        try {
          while (latest && !signal.aborted && !stopped) {
            const next = latest;
            latest = undefined;
            await push(next);
          }
        } catch {
          stopped = true;
          stopFeed?.();
        } finally {
          sending = false;
        }
      })();
    };
    const reconcile = () => {
      if (stopped || signal.aborted) return;
      const current = agent.current();
      const nextId =
        current?.provider === "pi"
          ? (current.runtimeInfo?.sessionId ?? current.persistence?.sessionId)
          : undefined;
      if (nextId === sessionId && stopFeed) return;
      stopFeed?.();
      stopFeed = undefined;
      sessionId = nextId;
      send({ type: "unavailable", message: "Waiting for the Pi presentation connection…" });
      if (nextId)
        stopFeed = followFeed(
          nextId,
          signal,
          (state) => send({ type: "state", state }),
          () =>
            send({ type: "unavailable", message: "Pi presentation disconnected; reconnecting…" }),
        );
    };
    const off = agent.subscribe(reconcile);
    try {
      await agent.refresh();
      reconcile();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      stopped = true;
      off();
      stopFeed?.();
    }
  });
  return () => {};
}
