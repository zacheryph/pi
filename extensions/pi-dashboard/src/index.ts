import { join } from "node:path";
import {
  getAgentDir,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { PresentationService } from "#presentation";
import { ActivityTracker } from "#presentation/activity";
import { dashboardSettings, type DashboardConfig } from "#src/config";
import { nodeRuntime, spawnHub } from "#src/launch";
import { hubPaths, type CommandRequest, type HubPaths, type UsageSection } from "#src/protocol";
import { Reporter } from "#src/reporter";
import { buildSnapshot } from "#presentation/snapshot";
import { StatusTracker } from "#presentation/status";
import { detectTerminal, type TerminalAdapter } from "#src/terminal";
import { sessionUsage } from "#presentation/usage";

/** One reporter per process: subagent children and other embedded sessions stay off the dashboard. */
const SLOT = Symbol.for("dashboard:reporter");
const PUBLISH_DELAY_MS = 250;

export interface DashboardDependencies {
  /** Hub directory; defaults to `<agent dir>/dashboard`. */
  dir?: string;
  loadConfig?: (cwd: string) => DashboardConfig;
  spawnHub?: (paths: HubPaths, config: DashboardConfig) => void;
  openUrl?: (url: string) => Promise<void>;
  isHubReachable?: (url: string) => Promise<boolean>;
  publishDelayMs?: number;
  pid?: number;
  /** Finds the terminal Focus brings forward; defaults to the cmux adapter. */
  detectTerminal?: () => TerminalAdapter | undefined;
}

async function hubReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("api/health", url), {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: unknown; protocol?: unknown };
    return body.ok === true && typeof body.protocol === "number";
  } catch {
    return false;
  }
}

export default function dashboardExtension(
  pi: ExtensionAPI,
  dependencies: DashboardDependencies = {},
): void {
  const pid = dependencies.pid ?? process.pid;
  const startedAt = Math.round(Date.now() - process.uptime() * 1000);
  const slots = globalThis as Record<symbol, unknown>;
  const token = Symbol("dashboard:runtime");
  let reporter: Reporter | undefined;
  let status = new StatusTracker();
  let current: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const presentation = new PresentationService(pi.events);
  let activity = new ActivityTracker();
  // Usage scans the session file, so it refreshes only after events that change it.
  let usage: UsageSection | undefined;
  let ledgerStale = true;
  let terminal: TerminalAdapter | undefined;

  const paths = () => hubPaths(dependencies.dir ?? join(getAgentDir(), "dashboard"));
  const loadConfig = (cwd: string) => (dependencies.loadConfig ?? dashboardSettings.load)(cwd);

  const snapshot = (ctx: ExtensionContext) => {
    if (ledgerStale) {
      usage = sessionUsage(ctx.sessionManager.getEntries());
      ledgerStale = false;
    }
    return buildSnapshot({
      id: String(pid),
      pid,
      startedAt,
      piVersion: VERSION,
      ctx,
      sessionName: pi.getSessionName(),
      thinking: pi.getThinkingLevel(),
      status: status.current(),
      ...presentation.snapshot(),
      usage,
      terminal: terminal?.info,
      activity: activity.section(),
    });
  };

  /** The session file changed: usage may have moved. */
  const ledger = (ctx: ExtensionContext) => {
    ledgerStale = true;
    schedule(ctx);
  };

  const publish = () => {
    timer = undefined;
    if (!reporter || !current) return;
    try {
      reporter.update(snapshot(current));
    } catch {
      /* the session is being replaced */
    }
  };

  /** Coalesces bursts of events into one update. */
  const schedule = (ctx?: ExtensionContext) => {
    if (ctx) current = ctx;
    if (!reporter || timer) return;
    timer = setTimeout(publish, dependencies.publishDelayMs ?? PUBLISH_DELAY_MS);
    timer.unref?.();
  };

  const stop = (reason: "quit" | "replace") => {
    clearTimeout(timer);
    timer = undefined;
    reporter?.close(reason);
    reporter = undefined;
    current = undefined;
    presentation.reset();
    activity = new ActivityTracker();
    usage = undefined;
    ledgerStale = true;
    terminal = undefined;
    if (slots[SLOT] === token) delete slots[SLOT];
  };

  presentation.subscribe(() => schedule());

  const answer = async (request: CommandRequest): Promise<unknown> => {
    if (request.command === "focus") {
      if (!terminal) throw new Error("This session's terminal does not support Focus.");
      await terminal.focus();
      return undefined;
    }
    return presentation.request(request);
  };

  pi.on("session_start", (_event, ctx) => {
    // Interactive sessions only; print, json and rpc runs (and subagent children, which run in print mode) are not shown.
    if (ctx.mode !== "tui") return;
    if (slots[SLOT] && slots[SLOT] !== token) return;
    slots[SLOT] = token;
    current = ctx;
    status = new StatusTracker();
    terminal = (dependencies.detectTerminal ?? detectTerminal)();
    const config = loadConfig(ctx.cwd);
    const hub = paths();
    reporter = new Reporter({
      socketPath: hub.socket,
      spawnHub: () =>
        (
          dependencies.spawnHub ??
          ((target, settings) =>
            spawnHub({ paths: target, port: settings.port, node: nodeRuntime(settings.node) }))
        )(hub, config),
      onUnavailable: () =>
        current?.ui.notify(`Session dashboard did not start; see ${hub.log}`, "warning"),
      onCommand: answer,
    });
    reporter.start(snapshot(ctx));
  });

  pi.on("session_shutdown", (event) => stop(event.reason === "quit" ? "quit" : "replace"));

  pi.on("session_info_changed", (_event, ctx) => schedule(ctx));
  pi.on("session_tree", (_event, ctx) => ledger(ctx));
  pi.on("model_select", (_event, ctx) => schedule(ctx));
  pi.on("thinking_level_select", (_event, ctx) => schedule(ctx));
  pi.on("turn_end", (_event, ctx) => schedule(ctx));
  pi.on("message_end", (_event, ctx) => ledger(ctx));
  pi.on("agent_start", (_event, ctx) => {
    status.agentStart();
    schedule(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    status.settled();
    status.compactEnd();
    activity.settle();
    schedule(ctx);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    // Calls made by another tool (codemode scripts) stay under their parent.
    if (event.parentToolCallId) return;
    status.toolStart(event.toolCallId, event.toolName);
    activity.start(event.toolCallId, event.toolName, event.args);
    schedule(ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    // However the asking call ended, its questionnaire is over.
    presentation.closeQuestion(event.toolCallId);
    if (event.parentToolCallId) return;
    status.toolEnd(event.toolCallId);
    activity.end(event.toolCallId, event.isError);
    schedule(ctx);
  });
  pi.on("session_before_compact", (_event, ctx) => {
    status.compactStart();
    schedule(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    status.compactEnd();
    ledger(ctx);
  });
  pi.on("session_compact_failed", (_event, ctx) => {
    status.compactEnd();
    schedule(ctx);
  });
  pi.on("ui_prompt_start", (event, ctx) => {
    status.promptStart(event.title);
    schedule(ctx);
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    status.promptEnd();
    schedule(ctx);
  });

  pi.registerCommand("dashboard", {
    description: "Open the web dashboard of running Pi sessions",
    handler: async (_args, ctx) => {
      const config = loadConfig(ctx.cwd);
      const url = `http://127.0.0.1:${config.port}/`;
      const reachable = dependencies.isHubReachable ?? hubReachable;
      let up = await reachable(url);
      // A hub this session just spawned may still be binding its port.
      for (let attempt = 0; !up && reporter && attempt < 6; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        up = await reachable(url);
      }
      if (!up) {
        ctx.ui.notify(
          reporter
            ? `Dashboard is not reachable at ${url}. Check ${paths().log}, or set "port" in ~/.pi/agent/dashboard.json if the port is taken.`
            : `Dashboard is not running at ${url}. It starts with the first interactive Pi session.`,
          "warning",
        );
        return;
      }
      ctx.ui.notify(`Dashboard: ${url}`, "info");
      const open =
        dependencies.openUrl ??
        (async (target: string) => {
          const command =
            process.platform === "darwin"
              ? "open"
              : process.platform === "win32"
                ? "explorer"
                : "xdg-open";
          await pi.exec(command, [target]);
        });
      try {
        await open(url);
      } catch {
        /* the URL is already shown */
      }
    },
  });
}
