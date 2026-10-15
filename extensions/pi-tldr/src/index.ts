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
  let summaryAbort: AbortController | undefined;
  let summaryInProgress = false;
  let firstRawInput: string | undefined;
  /** Only names applied during this session may be refreshed; resumed names are treated as manual. */
  let lastAutoTitle: string | undefined;

  const cancelPendingTitle = () => { autoAbort?.abort(); autoAbort = undefined; };
  const cancelPendingSummary = () => {
    summaryAbort?.abort();
    summaryAbort = undefined;
    summaryInProgress = false;
  };

  const restore = (ctx: ExtensionContext): void => {
    cancelPendingTitle();
    cancelPendingSummary();
    firstRawInput = undefined;
    lastAutoTitle = undefined;
    generation++;
    currentSessionId = ctx.sessionManager.getSessionId();
    // Do not auto-rename an existing/previously worked session on reload or resume.
    initialNamingAttempted = ctx.sessionManager.getBranch().some((e) =>
      e.type === "message" && e.message.role === "user");
    try {
      config = loadTldrConfig(ctx.cwd);
    }
    catch (error) {
      config = { ...DEFAULT_CONFIG, setSessionName: false };
      if (ctx.hasUI) ctx.ui.notify(`pi-tldr configuration: ${String(error)}`, "error");
    }
  };

  const isCurrent = (ctx: ExtensionContext, token: number, sessionId: string): boolean =>
    generation === token && currentSessionId === sessionId &&
    ctx.sessionManager.getSessionId() === sessionId;

  const mayRename = (ctx: ExtensionContext, token: number, sessionId: string): boolean =>
    config.setSessionName && isCurrent(ctx, token, sessionId);

  /** Never replace a name that was set manually, even when /tldr is run. */
  const applyTitle = (title: string): void => {
    const safeTitle = titleSlug(title);
    if (!safeTitle || !config.setSessionName) return;
    const existing = pi.getSessionName();
    if (existing && existing !== lastAutoTitle) return;
    if (existing !== safeTitle) pi.setSessionName(safeTitle);
    lastAutoTitle = safeTitle;
  };

  // Input is captured before skill/template expansion. Fallback below supports other prompt sources.
  pi.on("input", (event, ctx) => {
    if (event.source === "interactive" && ctx.mode === "tui" && ctx.hasUI &&
        !initialNamingAttempted && firstRawInput === undefined) {
      firstRawInput = event.text.trim();
    }
  });

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => {
    cancelPendingTitle();
    cancelPendingSummary();
    firstRawInput = undefined;
    lastAutoTitle = undefined;
    generation++;
    currentSessionId = ctx.sessionManager.getSessionId();
    initialNamingAttempted = ctx.sessionManager.getBranch().some((e) =>
      e.type === "message" && e.message.role === "user");
  });
  pi.on("session_before_switch", () => { cancelPendingTitle(); cancelPendingSummary(); firstRawInput = undefined; lastAutoTitle = undefined; generation++; });
  pi.on("session_shutdown", () => { cancelPendingTitle(); cancelPendingSummary(); firstRawInput = undefined; lastAutoTitle = undefined; generation++; });

  pi.on("before_agent_start", (event, ctx) => {
    if (!("prompt" in event) || initialNamingAttempted) return;
    initialNamingAttempted = true;
    if (ctx.mode !== "tui" || !ctx.hasUI || !config.setSessionName || pi.getSessionName()) return;
    const prompt = (firstRawInput ?? event.prompt).trim();
    firstRawInput = undefined;
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
      if (title && mayRename(ctx, token, sessionId) && !pi.getSessionName()) applyTitle(title);
    })().catch((error) => {
      if (!controller.signal.aborted && isCurrent(ctx, token, sessionId) && ctx.hasUI) {
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
      if (summaryInProgress) {
        ctx.ui.notify("/tldr is already summarizing this session.", "info");
        return;
      }
      const token = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      const controller = new AbortController();
      summaryAbort = controller;
      summaryInProgress = true;
      try {
        // Open the modal immediately; its body handles loading and errors.
        await showTldr(ctx, async (modalSignal) => {
          const signal = AbortSignal.any([modalSignal, controller.signal]);
          if (signal.aborted) throw new Error("Summarization cancelled");
          const model = selectTldrModel(ctx, config.model);
          const result = parseTldrResponse(await runTldrModel(ctx, model, content, "summary", signal));
          if (!isCurrent(ctx, token, sessionId) || signal.aborted) throw new Error("Summarization cancelled");
          if (mayRename(ctx, token, sessionId) && result.title) applyTitle(result.title);
          return result;
        });
      } catch (error) {
        if (!controller.signal.aborted && isCurrent(ctx, token, sessionId))
          ctx.ui.notify(`pi-tldr: ${String(error)}`, "error");
      } finally {
        controller.abort();
        if (summaryAbort === controller) {
          summaryAbort = undefined;
          summaryInProgress = false;
        }
      }
    },
  });
}
