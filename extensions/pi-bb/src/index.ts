import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { userOutput } from "#foundations/user-output";
import { PresentationService } from "#presentation";
import { ActivityTracker } from "#presentation/activity";
import type { UsageSection } from "#presentation/contract";
import { buildSnapshot } from "#presentation/snapshot";
import { StatusTracker } from "#presentation/status";
import { sessionUsage } from "#presentation/usage";
import { SurfaceClient, type ConnectionState, type SocketFactory } from "#src/client";
import { ENV_TOKEN, ENV_URL, readSurfaceEnv, type SurfaceEnv } from "#src/protocol";

/**
 * One connection per process: subagent children load this extension again in
 * the same process and must not report as the thread's session.
 */
const SLOT = Symbol.for("bb:surface");
const PUBLISH_DELAY_MS = 250;

export interface BbDependencies {
  /** Defaults to `process.env`, read on every `session_start`. */
  env?: () => NodeJS.ProcessEnv;
  pid?: number;
  publishDelayMs?: number;
  socket?: SocketFactory;
  minDelayMs?: number;
  maxDelayMs?: number;
}

function statusText(state: ConnectionState | undefined, endpoint: SurfaceEnv | undefined): string {
  if (!endpoint)
    return `bb surface: inactive. It runs only when bb starts this Pi for a thread with the pi-surface bb plugin installed (${ENV_URL} and ${ENV_TOKEN} are not set).`;
  switch (state?.kind) {
    case "connected":
      return `bb surface: connected for thread ${endpoint.threadId}.`;
    case "connecting":
      return `bb surface: connecting to the pi-surface plugin (attempt ${state.attempts + 1}).`;
    case "refused":
      return `bb surface: the pi-surface plugin refused this session (${state.code}${state.reason ? `: ${state.reason}` : ""}). Restart the thread after reinstalling the plugin.`;
    default:
      return "bb surface: inactive in this session (only the thread's main RPC session connects).";
  }
}

/** Shows this bundle's session state (todos, subagents, stash, git, questions) in bb's UI through the pi-surface bb plugin. */
export default function piBb(pi: ExtensionAPI, dependencies: BbDependencies = {}): void {
  const pid = dependencies.pid ?? process.pid;
  const startedAt = Math.round(Date.now() - process.uptime() * 1000);
  const slots = globalThis as Record<symbol, unknown>;
  const token = Symbol("bb:runtime");
  // Built in the factory so producers' session_start snapshots are seen; it is
  // idle unless a client is connected.
  const presentation = new PresentationService(pi.events);
  let client: SurfaceClient | undefined;
  let endpoint: SurfaceEnv | undefined;
  let status = new StatusTracker();
  let activity = new ActivityTracker();
  let current: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Usage scans the session file, so it refreshes only after events that change it.
  let usage: UsageSection | undefined;
  let ledgerStale = true;

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
      activity: activity.section(),
    });
  };

  const publish = () => {
    timer = undefined;
    if (!client || !current) return;
    try {
      client.update(snapshot(current));
    } catch {
      /* the session is being replaced */
    }
  };

  /** Coalesces bursts of events into one update. */
  const schedule = (ctx?: ExtensionContext) => {
    if (ctx) current = ctx;
    if (!client || timer) return;
    timer = setTimeout(publish, dependencies.publishDelayMs ?? PUBLISH_DELAY_MS);
    timer.unref?.();
  };

  /** The session file changed: usage may have moved. */
  const ledger = (ctx: ExtensionContext) => {
    ledgerStale = true;
    schedule(ctx);
  };

  const stop = (reason: "quit" | "replace") => {
    clearTimeout(timer);
    timer = undefined;
    client?.close(reason);
    client = undefined;
    current = undefined;
    presentation.reset();
    activity = new ActivityTracker();
    usage = undefined;
    ledgerStale = true;
    if (slots[SLOT] === token) delete slots[SLOT];
  };

  presentation.subscribe(() => schedule());

  pi.on("session_start", (_event, ctx) => {
    // bb runs Pi in RPC mode; subagent children run in print mode and never connect.
    if (ctx.mode !== "rpc") return;
    endpoint = readSurfaceEnv((dependencies.env ?? (() => process.env))());
    if (!endpoint) return;
    if (slots[SLOT] && slots[SLOT] !== token) return;
    slots[SLOT] = token;
    current = ctx;
    status = new StatusTracker();
    client = new SurfaceClient({
      endpoint,
      onRequest: (request) => presentation.request(request),
      ...(dependencies.socket ? { socket: dependencies.socket } : {}),
      ...(dependencies.minDelayMs !== undefined ? { minDelayMs: dependencies.minDelayMs } : {}),
      ...(dependencies.maxDelayMs !== undefined ? { maxDelayMs: dependencies.maxDelayMs } : {}),
    });
    try {
      client.start(snapshot(ctx));
    } catch {
      stop("quit");
    }
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

  const output = userOutput(pi, "bb:status");
  pi.registerCommand("bb", {
    description: "Show whether this session reports to bb's pi-surface plugin",
    handler: async (_args, ctx) => {
      // bb drops notify; outside the terminal this is a displayed message kept out of the model's context.
      output.show(ctx, statusText(client?.state, endpoint));
    },
  });
}
