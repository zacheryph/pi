import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { userOutput } from "#foundations/user-output";
import {
  advertiseFormConsumer,
  batchViews,
  BB_MESSAGE_BYTES,
  collectDelivery,
  dispatchAction,
  type ViewBatcher,
} from "#surface";
import { SurfaceClient, type ConnectionState, type SocketFactory } from "#src/client";
import {
  ENV_THREAD,
  ENV_TOKEN,
  ENV_URL,
  helloFramingBytes,
  readSurfaceEnv,
  type SurfaceEnv,
} from "#src/protocol";
import {
  allowedBbSkills,
  dropBbSkills,
  dropEnvironmentTool,
  ENV_KEEP_ENVIRONMENT_TOOL,
} from "#src/prompt";

/**
 * One connection per process: subagent children load this extension again in
 * the same process and must not report as the thread's session.
 */
const SLOT = Symbol.for("bb:surface");
const PUBLISH_DELAY_MS = 250;
/** Who answers forms, as surface's form-consumer discovery names it. */
const FORM_CONSUMER = "bb";

export interface BbDependencies {
  /** Defaults to `process.env`, read on every `session_start`. */
  env?: () => NodeJS.ProcessEnv;
  pid?: number;
  publishDelayMs?: number;
  socket?: SocketFactory;
  minDelayMs?: number;
  maxDelayMs?: number;
  /** The plugin's message limit in UTF-8 bytes. Default `BB_MESSAGE_BYTES` (2 MiB). */
  maxMessageBytes?: number;
}

function statusText(
  state: ConnectionState | undefined,
  endpoint: SurfaceEnv | undefined,
  problem: string | undefined,
): string {
  if (!endpoint)
    return `bb surface: inactive. It runs only when bb starts this Pi for a thread with the pi-surface bb plugin installed (${ENV_URL} and ${ENV_TOKEN} are not set).`;
  const note = problem ? ` The last update could not be sent: ${problem}` : "";
  switch (state?.kind) {
    case "connected":
      return `bb surface: connected for thread ${endpoint.threadId}.${note}`;
    case "connecting":
      return `bb surface: connecting to the pi-surface plugin (attempt ${state.attempts + 1}).${note}`;
    case "refused":
      return `bb surface: the pi-surface plugin refused this session (${state.code}${state.reason ? `: ${state.reason}` : ""}). Restart the thread after reinstalling the plugin.`;
    default:
      return "bb surface: inactive in this session (only the thread's main RPC session connects).";
  }
}

/**
 * Shows this bundle's session state in bb's UI through the pi-surface bb
 * plugin: every view registered on the session's bus (pi-surface), collected
 * into one complete snapshot per update, and the plugin's action requests run
 * on the same bus. The session's core state is the `system.session` view of
 * pi-system-insights; this adapter observes nothing itself.
 */
export default function piBb(pi: ExtensionAPI, dependencies: BbDependencies = {}): void {
  const pid = dependencies.pid ?? process.pid;
  const slots = globalThis as Record<symbol, unknown>;
  const token = Symbol("bb:runtime");
  let client: SurfaceClient | undefined;
  let endpoint: SurfaceEnv | undefined;
  let batcher: ViewBatcher | undefined;
  let revokeForms: (() => void) | undefined;
  /** Why the last collection could not be sent, for `/bb`; cleared by the next one that is. */
  let problem: string | undefined;

  const withdrawForms = () => {
    revokeForms?.();
    revokeForms = undefined;
  };

  const stop = (reason: "quit" | "replace") => {
    batcher?.dispose();
    batcher = undefined;
    withdrawForms();
    client?.close(reason);
    client = undefined;
    problem = undefined;
    if (slots[SLOT] === token) delete slots[SLOT];
  };

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    // bb runs Pi in RPC mode; subagent children run in print mode and never connect.
    if (ctx.mode !== "rpc") return;
    endpoint = readSurfaceEnv((dependencies.env ?? (() => process.env))());
    if (!endpoint) return;
    if (slots[SLOT] && slots[SLOT] !== token) return;
    slots[SLOT] = token;
    const bus = pi.events;
    const surface = new SurfaceClient({
      endpoint,
      onRequest: ({ action, args }) => dispatchAction(bus, action, args),
      // Forms go to bb only while a plugin that speaks this protocol has accepted the session.
      onAccepted: () => {
        withdrawForms();
        revokeForms = advertiseFormConsumer(bus, { name: FORM_CONSUMER });
      },
      onLost: withdrawForms,
      ...(dependencies.socket ? { socket: dependencies.socket } : {}),
      ...(dependencies.minDelayMs !== undefined ? { minDelayMs: dependencies.minDelayMs } : {}),
      ...(dependencies.maxDelayMs !== undefined ? { maxDelayMs: dependencies.maxDelayMs } : {}),
    });
    client = surface;
    const budget = {
      maxBytes: dependencies.maxMessageBytes ?? BB_MESSAGE_BYTES,
      framingBytes: helloFramingBytes(endpoint.threadId, endpoint.token),
    };
    const id = String(pid);
    surface.start();
    // Collects now and after each burst of view announcements, for as long as the session lasts.
    batcher = batchViews(bus, {
      delayMs: dependencies.publishDelayMs ?? PUBLISH_DELAY_MS,
      flush: () => {
        const result = collectDelivery(bus, { id, host: { pid }, budget });
        if (!result.ok) {
          problem = result.error;
          return;
        }
        problem = result.evicted.length
          ? `left out ${result.evicted.join(", ")} to fit one message.`
          : undefined;
        surface.update(result.json);
      },
      onError: (error) => {
        problem = error instanceof Error ? error.message : String(error);
      },
    });
  });

  // bb puts every enabled plugin's skills, and its own update_environment_directory tool,
  // into each thread's prompt, and no setting or plugin can drop them. Pi lets the prompt
  // inputs be edited here.
  pi.on("before_agent_start", (event, ctx) => {
    const env = (dependencies.env ?? (() => process.env))();
    if (ctx.mode !== "rpc" || !env[ENV_THREAD]) return;
    const options = event.systemPromptOptions;
    dropBbSkills(options.skills, allowedBbSkills(env));
    if (env[ENV_KEEP_ENVIRONMENT_TOOL] !== "1") dropEnvironmentTool(options);
  });

  pi.on("session_shutdown", (event) => stop(event.reason === "quit" ? "quit" : "replace"));

  const output = userOutput(pi, "bb:status");
  pi.registerCommand("bb", {
    description: "Show whether this session reports to bb's pi-surface plugin",
    handler: async (_args, ctx) => {
      // bb drops notify; outside the terminal this is a displayed message kept out of the model's context.
      output.show(ctx, statusText(client?.state, endpoint, problem));
    },
  });
}
