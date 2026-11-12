import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PresentationService } from "pi-presentation";
import { serveFeed } from "../../plugins/pi/server/host.ts";

/** Opt-in RPC adapter, loaded by the Paseo Pi command wrapper only. */
export default function paseoPresentation(pi: ExtensionAPI): void {
  const service = new PresentationService(pi.events);
  let close: (() => Promise<void>) | undefined;
  let closing = Promise.resolve();
  let generation = 0;
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "rpc") return;
    const expected = ++generation;
    await closing;
    if (expected !== generation) return;
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      const stop = await serveFeed(
        sessionId,
        () => {
          const { todos, subagents } = service.snapshot();
          return {
            version: 1,
            sessionId,
            todos,
            subagents: subagents ? { agents: subagents.agents.slice(0, 100) } : undefined,
          };
        },
        (listener) => service.subscribe(listener),
      );
      if (generation !== expected) await stop();
      else close = stop;
    } catch (error) {
      ctx.ui.notify(`Pi presentation unavailable: ${String(error)}`, "warning");
    }
  });
  pi.on("session_shutdown", () => {
    generation++;
    const stop = close;
    close = undefined;
    closing = closing.then(async () => {
      if (stop) await stop();
    });
    service.reset();
    return closing;
  });
}
