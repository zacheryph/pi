/**
 * `ensureWorkHost(pi)`: every extension that produces or shows work calls it from its factory.
 * The first session_start handler to find no host offered for this session id provides the
 * root host; any other extension (and any later caller) finds that one. A host can also be
 * provided by someone other than the session before its extensions bind (a managed child's
 * host, whose wake policy asks the agent's manager for a run): then `ensureWorkHost` provides
 * nothing and only wires the session's run boundaries to whichever host is offered.
 *
 * The root host's wake policy starts a turn (`sendMessage(..., { triggerTurn: true })`) when
 * the session is idle, and records the message for the end of the turn when a run is active.
 *
 * Landing (when a completed item's message has reached the transcript) is read by the
 * `LandingTracker` (landing.ts) of the instance that provided the host, and by no other: an
 * instance that only finds a host forwards the run boundaries and reads nothing.
 */
import { readEntries } from "../../pi-session-state/src/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { provide, service } from "../../pi-session-tree/src/index.ts";
import {
  WORK_ENTRY,
  WORK_SERVICE,
  type WorkHost,
  type WorkMessage,
  type WorkRecord,
} from "./contract.ts";
import type { BeforeSettleEvent, DeliveryHost } from "./delivery.ts";
import { createWorkHost, type WorkHostRuntime, type WorkStore } from "./host.ts";
import { createLandingTracker, type LandingTracker } from "./landing.ts";

/** How a producer reaches the session's host. */
export interface WorkAccess {
  /**
   * The work host offered for this session: undefined until `session_start` has run for the
   * session, and again after `session_shutdown`. Read it in `session_start` handlers and
   * tools, not in the factory. Always the live one, so keep no reference across a reload.
   */
  host(): WorkHost | undefined;
}

/** The slice of a session context the root host reads. Stale contexts throw. */
interface Context {
  isIdle(): boolean;
  ui?: { notify?(message: string, level?: "info" | "warning" | "error"): void };
  sessionManager: {
    getSessionId(): string;
    getBranch(): readonly {
      id?: string;
      type: string;
      customType?: string;
      data?: unknown;
      content?: unknown;
      details?: unknown;
    }[];
  };
}

/** The optional run-boundary hooks a host may offer (`WorkHostRuntime` does). */
interface BoundaryHooks {
  agentStart?(): void;
  agentSettled?(): void;
  continuesRun?(event: BeforeSettleEvent): boolean;
}

const isHost = (value: unknown): value is WorkHost =>
  !!value &&
  typeof (value as WorkHost).open === "function" &&
  typeof (value as WorkHost).adopt === "function" &&
  typeof (value as WorkHost).list === "function";

const accesses = new WeakMap<object, WorkAccess>();

export function ensureWorkHost(pi: ExtensionAPI): WorkAccess {
  const known = accesses.get(pi);
  if (known) return known;

  let sessionId: string | undefined;
  let ctxRef: Context | undefined;
  /** The host this instance provided, if the session had none, with the tracker that reads its landings. */
  let local:
    | { runtime: WorkHostRuntime; landing: LandingTracker; withdraw: () => void }
    | undefined;

  const remember = (ctx: unknown) => {
    if (ctx && typeof ctx === "object") ctxRef = ctx as Context;
  };
  const offered = (ctx: unknown): (WorkHost & BoundaryHooks) | undefined => {
    let id = sessionId;
    try {
      id = (ctx as Context).sessionManager.getSessionId();
    } catch {}
    const found = id === undefined ? undefined : service<unknown>(id, WORK_SERVICE);
    return isHost(found) ? found : undefined;
  };

  const transport: DeliveryHost<WorkMessage> = {
    isIdle: () => (typeof ctxRef?.isIdle === "function" ? ctxRef.isIdle() : true),
    send: (items, mode) => {
      items.forEach((item, index) => {
        const { customType, content, details } = item.payload;
        pi.sendMessage(
          { customType, content, display: true, ...(details !== undefined ? { details } : {}) },
          // Only the last message starts the run; the ones before it are already in the
          // transcript (idle) or held for the end of the turn (running).
          { triggerTurn: mode === "wake" && index === items.length - 1 },
        );
      });
      // Pi appends at once when it is neither streaming nor starting a run for it.
      local?.landing.sent();
    },
    lost: (items) => {
      try {
        ctxRef?.ui?.notify?.(
          `pi-work: session context is gone; ${items.length} work message${items.length === 1 ? " was" : "s were"} not delivered.`,
          "warning",
        );
      } catch {}
    },
  };

  const store = (ctx: Context): WorkStore => ({
    read: () => readEntries(ctx, { type: WORK_ENTRY }),
    append: (record: WorkRecord) => pi.appendEntry(WORK_ENTRY, record),
  });

  pi.on("session_start", async (_event, ctx) => {
    remember(ctx);
    const context = ctx as unknown as Context;
    sessionId = context.sessionManager.getSessionId();
    if (isHost(service<unknown>(sessionId, WORK_SERVICE))) return;
    const landing = createLandingTracker({
      branch: () => (ctxRef as Context).sessionManager.getBranch(),
      target: () => local?.runtime,
    });
    const runtime = createWorkHost({
      store: store(context),
      delivery: transport,
      // Pi holds a message sent mid-run until the turn ends: close the item once it is written.
      confirmLanding: true,
      landingMark: () => landing.mark(),
      // Lost work is shown without starting a turn. The message is already in the transcript.
      onLost: (items) => {
        try {
          ctxRef?.ui?.notify?.(
            `pi-work: ${items.length} open work item${items.length === 1 ? "" : "s"} could not be taken over after the restart and ${items.length === 1 ? "was" : "were"} closed as lost.`,
            "warning",
          );
        } catch {}
      },
    });
    runtime.start();
    local = { runtime, landing, withdraw: provide(sessionId, WORK_SERVICE, runtime) };
  });

  // `resources_discover` fires after every extension's session_start handler has finished (even
  // the asynchronous ones), so by now each owner has had its chance to adopt. The first agent
  // start is the fallback for a mode that never emits it.
  const settle = (ctx: unknown) => {
    remember(ctx);
    local?.runtime.settleStartup();
  };
  pi.on("resources_discover", async (_event, ctx) => {
    settle(ctx);
    return undefined;
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    settle(ctx);
    return undefined;
  });

  // Landing is read at the boundaries that follow the end of a turn (see LandingTracker).
  pi.on("message_end", async (_event, ctx) => {
    remember(ctx);
    local?.landing.observe("message_end");
  });
  pi.on("turn_start", async (_event, ctx) => {
    remember(ctx);
    local?.landing.observe("turn_start");
  });
  pi.on("agent_end", async (_event, ctx) => {
    remember(ctx);
    local?.landing.observe("agent_end");
  });
  // The leaf moved: a message sent on the branch it left cannot land on the new one.
  pi.on("session_tree", async (_event, ctx) => {
    remember(ctx);
    local?.landing.observe("session_tree");
  });

  pi.on("agent_start", async (_event, ctx) => {
    remember(ctx);
    offered(ctx)?.agentStart?.();
  });
  pi.on("agent_settled", async (_event, ctx) => {
    remember(ctx);
    local?.landing.observe("agent_settled");
    offered(ctx)?.agentSettled?.();
  });
  // A work message that landed after the model's last answer needs one more request in this run.
  pi.on("agent_before_settle", async (event, ctx) => {
    remember(ctx);
    local?.landing.observe("agent_before_settle");
    if (event.continue) return undefined; // another handler already asked for it
    return offered(ctx)?.continuesRun?.(event as unknown as BeforeSettleEvent)
      ? { continue: true }
      : undefined;
  });

  pi.on("session_shutdown", async () => {
    const mine = local;
    if (!mine) return;
    mine.landing.check(); // a message already in the transcript closes its item before the host goes
    local = undefined;
    mine.landing.dispose();
    mine.runtime.dispose();
    mine.withdraw();
  });

  const access: WorkAccess = {
    host: () => {
      const found = sessionId === undefined ? undefined : service<unknown>(sessionId, WORK_SERVICE);
      return isHost(found) ? found : undefined;
    },
  };
  accesses.set(pi, access);
  return access;
}
