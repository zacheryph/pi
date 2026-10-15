import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadTldrConfig, type TldrConfig } from "./config.js";
import { parseTldrResponse, runTldrModel, selectTldrModel, sessionSnapshot, titleSlug } from "./core.js";
import { showTldr } from "./viewer.js";

/** Autonomous title request is deliberately never awaited by the first agent run. */
export default function piTldr(pi: ExtensionAPI): void {
  let config: TldrConfig = { ...DEFAULT_CONFIG };
  let generation = 0;
  let initialNamingAttempted = false;
  let currentSessionId: string | undefined;
  let autoAbort: AbortController | undefined;

  const cancelPendingTitle = () => { autoAbort?.abort(); autoAbort = undefined; };

  const restore = (ctx: ExtensionContext): void => {
    cancelPendingTitle();
    generation++;
    currentSessionId = ctx.sessionManager.getSessionId();
    // Do not auto-rename an existing/previously worked session on reload or resume.
    initialNamingAttempted = ctx.sessionManager.getBranch().some((e) =>
      e.type === "message" && e.message.role === "user");
    try {
      config = loadTldrConfig(ctx.cwd);
      const name = pi.getSessionName();
      if (config.setSessionName && name && ctx.hasUI) ctx.ui.setTitle(titleSlug(name) ?? name);
    }
    catch (error) {
      config = { ...DEFAULT_CONFIG, setSessionName: false };
      if (ctx.hasUI) ctx.ui.notify(`pi-tldr configuration: ${String(error)}`, "error");
    }
  };

  const canRename = (ctx: ExtensionContext, token: number, sessionId: string): boolean =>
    config.setSessionName && generation === token && currentSessionId === sessionId &&
    ctx.sessionManager.getSessionId() === sessionId;

  const applyTitle = (title: string, ctx: ExtensionContext): void => {
    const safeTitle = titleSlug(title);
    if (!safeTitle || !config.setSessionName) return;
    if (pi.getSessionName() !== safeTitle) pi.setSessionName(safeTitle);
    if (ctx.hasUI) ctx.ui.setTitle(safeTitle);
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => {
    cancelPendingTitle();
    generation++;
    currentSessionId = ctx.sessionManager.getSessionId();
    initialNamingAttempted = ctx.sessionManager.getBranch().some((e) =>
      e.type === "message" && e.message.role === "user");
  });
  pi.on("session_before_switch", () => { cancelPendingTitle(); generation++; });
  pi.on("session_shutdown", () => { cancelPendingTitle(); generation++; });

  pi.on("before_agent_start", (event, ctx) => {
    if (event.messageType !== "user" || initialNamingAttempted) return;
    initialNamingAttempted = true;
    if (!config.setSessionName || pi.getSessionName()) return;
    const prompt = event.prompt?.trim();
    if (!prompt) return;
    const token = generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const controller = new AbortController();
    autoAbort = controller;
    // Fire and forget: the main model is never held behind the naming model.
    void (async () => {
      const model = selectTldrModel(ctx, config.model);
      const title = titleSlug(await runTldrModel(ctx, model, prompt.slice(0, 3000), "title", controller.signal));
      // Never clobber a title the user set during generation.
      if (title && canRename(ctx, token, sessionId) && !pi.getSessionName()) applyTitle(title, ctx);
    })().catch((error) => {
      if (!controller.signal.aborted && canRename(ctx, token, sessionId) && ctx.hasUI) {
        ctx.ui.notify(`pi-tldr could not name session: ${String(error)}`, "warning");
      }
    }).finally(() => { if (autoAbort === controller) autoAbort = undefined; });
  });

  pi.registerCommand("tldr", {
    description: "Concise current-session premise, major findings, and status",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify("/tldr requires interactive terminal mode.", "warning");
        return;
      }
      const content = sessionSnapshot(ctx);
      if (!ctx.sessionManager.getBranch().some((e) => e.type === "message" && e.message.role === "user")) {
        ctx.ui.notify("No session messages to summarize yet.", "info");
        return;
      }
      const token = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      ctx.ui.setStatus("pi-tldr", "Summarizing session…");
      try {
        const model = selectTldrModel(ctx, config.model);
        const result = parseTldrResponse(await runTldrModel(ctx, model, content, "summary"));
        if (!canRename(ctx, token, sessionId) && generation !== token) return;
        if (canRename(ctx, token, sessionId) && result.title) applyTitle(result.title, ctx);
        await showTldr(ctx, result);
      } catch (error) {
        if (generation === token) ctx.ui.notify(`pi-tldr: ${String(error)}`, "error");
      } finally {
        if (generation === token) ctx.ui.setStatus("pi-tldr", undefined);
      }
    },
  });
}
