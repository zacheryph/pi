import { join } from "node:path";
import { userOutput } from "#foundations/user-output";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  advertiseFormConsumer,
  batchViews,
  collectDelivery,
  dispatchAction,
  type HostInfo,
  type ViewBatcher,
} from "#surface";
import { dashboardSettings, type DashboardConfig } from "#src/config";
import { nodeRuntime, spawnHub } from "#src/launch";
import {
  hubPaths,
  MAX_LINE_BYTES,
  SNAPSHOT_FRAMING_BYTES,
  type CommandRequest,
  type HubPaths,
  type JsonValue,
} from "#src/protocol";
import { Reporter } from "#src/reporter";
import { detectTerminal, type TerminalAdapter } from "#src/terminal";

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
  /** The hub's line limit in UTF-8 bytes; tests lower it. */
  maxLineBytes?: number;
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

/**
 * Reports this interactive session to the dashboard hub. What the page shows
 * is the session's views, collected by pi-surface into one complete snapshot
 * per update: core session state from pi-system-insights' `system.session`,
 * and each extension's own summaries, widgets, explorers and forms. The page's
 * requests come back as Focus, which this adapter owns, or as an action one
 * of those views offers.
 */
export default function dashboardExtension(
  pi: ExtensionAPI,
  dependencies: DashboardDependencies = {},
): void {
  const output = userOutput(pi, "dashboard:output");
  const pid = dependencies.pid ?? process.pid;
  const slots = globalThis as Record<symbol, unknown>;
  const token = Symbol("dashboard:runtime");
  let reporter: Reporter | undefined;
  let batcher: ViewBatcher | undefined;
  let current: ExtensionContext | undefined;
  let terminal: TerminalAdapter | undefined;
  let revokeForms: (() => void) | undefined;
  /** Problems already told to the user this runtime, so a repeated one is told once. */
  const warned = new Set<string>();

  const paths = () => hubPaths(dependencies.dir ?? join(getAgentDir(), "dashboard"));
  const loadConfig = (cwd: string) => (dependencies.loadConfig ?? dashboardSettings.load)(cwd);

  const warn = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    try {
      current?.ui.notify(message, "warning");
    } catch {
      /* the session is being replaced */
    }
  };

  /** The session's complete snapshot as JSON, sized to fit one hub line. */
  const deliver = (): string => {
    const id = String(pid);
    const host: HostInfo = { pid, ...(terminal ? { terminal: terminal.info } : {}) };
    const result = collectDelivery(pi.events, {
      id,
      host,
      budget: {
        maxBytes: dependencies.maxLineBytes ?? MAX_LINE_BYTES,
        framingBytes: SNAPSHOT_FRAMING_BYTES,
      },
    });
    if (result.ok) {
      if (result.evicted.length)
        warn(
          "evicted",
          `Session dashboard: left out ${result.evicted.join(", ")} to fit one update.`,
        );
      return result.json;
    }
    // The card and Focus still work without views; say why the rest is missing.
    warn("collect", `Session dashboard: ${result.error}`);
    return JSON.stringify({ id, host, views: [] });
  };

  const withdrawForms = () => {
    const revoke = revokeForms;
    revokeForms = undefined;
    revoke?.();
  };

  const stop = (reason: "quit" | "replace") => {
    batcher?.dispose();
    batcher = undefined;
    withdrawForms();
    reporter?.close(reason);
    reporter = undefined;
    current = undefined;
    terminal = undefined;
    if (slots[SLOT] === token) delete slots[SLOT];
  };

  const run = async (request: CommandRequest): Promise<JsonValue | undefined> => {
    if (request.command === "focus") {
      if (!terminal) throw new Error("This session's terminal does not support Focus.");
      await terminal.focus();
      return undefined;
    }
    return dispatchAction(pi.events, request.action, request.args);
  };

  pi.on("session_start", (_event, ctx) => {
    // Interactive sessions only; print, json and rpc runs (and subagent children, which run in print mode) are not shown.
    if (ctx.mode !== "tui") return;
    if (slots[SLOT] && slots[SLOT] !== token) return;
    slots[SLOT] = token;
    current = ctx;
    warned.clear();
    terminal = (dependencies.detectTerminal ?? detectTerminal)();
    const config = loadConfig(ctx.cwd);
    const hub = paths();
    const session = new Reporter({
      socketPath: hub.socket,
      spawnHub: () =>
        (
          dependencies.spawnHub ??
          ((target, settings) =>
            spawnHub({ paths: target, port: settings.port, node: nodeRuntime(settings.node) }))
        )(hub, config),
      onUnavailable: () =>
        current?.ui.notify(`Session dashboard did not start; see ${hub.log}`, "warning"),
      onRefused: (reason) => warn("refused", `Session dashboard: ${reason}`),
      // Forms are answerable from the page only while a hub that draws them has this session.
      onConnected: () => {
        withdrawForms();
        revokeForms = advertiseFormConsumer(pi.events, { name: "dashboard" });
      },
      onDisconnected: withdrawForms,
      onCommand: run,
    });
    reporter = session;
    // Collects at once, so the hello carries a complete snapshot, then after each burst of changes.
    batcher = batchViews(pi.events, {
      delayMs: dependencies.publishDelayMs ?? PUBLISH_DELAY_MS,
      flush: () => session.update(deliver()),
    });
    session.start();
  });

  pi.on("session_shutdown", (event) => stop(event.reason === "quit" ? "quit" : "replace"));

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
        output.show(
          ctx,
          reporter
            ? `Dashboard is not reachable at ${url}. Check ${paths().log}, or set "port" in ~/.pi/agent/dashboard.json if the port is taken.`
            : `Dashboard is not running at ${url}. It starts with the first interactive Pi session.`,
          "warning",
        );
        return;
      }
      if (ctx.mode !== "tui") {
        // The host may not be this machine's desktop, so the URL is shown rather than opened.
        output.show(
          ctx,
          `Dashboard: ${url} (it lists terminal sessions; this session is not one of them)`,
          "info",
        );
        return;
      }
      output.show(ctx, `Dashboard: ${url}`, "info");
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
