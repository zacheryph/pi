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
 */
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
  awaitingLanding?(): boolean;
  messageLanded?(
    message: { customType?: string; content?: unknown; details?: unknown },
    accepts?: (mark: unknown) => boolean,
  ): void;
  landingMarks?(): readonly unknown[];
  reviseLanding?(revise: (mark: unknown) => unknown): void;
}

/**
 * Where the transcript stood when a completion was sent: its message can only be an entry at
 * `index` or later. `anchor` is the id of the entry before it, to notice that the leaf moved to
 * another branch.
 */
interface LandingMark {
  index: number;
  anchor: string | undefined;
}

const isHost = (value: unknown): value is WorkHost =>
  !!value &&
  typeof (value as WorkHost).open === "function" &&
  typeof (value as WorkHost).adopt === "function" &&
  typeof (value as WorkHost).list === "function";

/** How many of the newest transcript entries are read to find a message that has landed. */
const LANDING_SCAN = 1000;

const accesses = new WeakMap<object, WorkAccess>();

export function ensureWorkHost(pi: ExtensionAPI): WorkAccess {
  const known = accesses.get(pi);
  if (known) return known;

  let sessionId: string | undefined;
  let ctxRef: Context | undefined;
  /** The host this instance provided, if the session had none. */
  let local: { runtime: WorkHostRuntime; withdraw: () => void } | undefined;

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
      queueMicrotask(() => checkLanding(ctxRef));
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

  /**
   * Which of the host's completed items have their message in the transcript now. Pi holds a
   * message sent mid-run and appends it at the end of the turn, and tells extensions nothing
   * when it does, so the transcript itself is read: after a send, and at the run boundaries that
   * follow the end of a turn. Only while an item waits, and only the newest entries.
   */
  const checkLanding = (ctx: unknown, settled = false) => {
    try {
      const host = offered(ctx);
      if (!host?.awaitingLanding?.()) return;
      const branch = (ctx as Context).sessionManager.getBranch();
      const end = branch.length;
      const isMark = (mark: unknown): mark is LandingMark =>
        typeof (mark as LandingMark | undefined)?.index === "number";
      // A message sent on a branch the leaf has left cannot land on this one.
      host.reviseLanding?.((mark) =>
        isMark(mark) && (mark.index === 0 || branch[mark.index - 1]?.id === mark.anchor)
          ? mark
          : undefined,
      );
      const first = Math.min(
        ...(host.landingMarks?.() ?? []).map((mark) => (isMark(mark) ? mark.index : end)),
      );
      // Oldest entry first, so identical messages are taken in the order they were sent, and
      // only entries after the mark: an identical message that landed earlier is not this one.
      for (let i = Math.max(first, end - LANDING_SCAN, 0); i < end; i++) {
        const entry = branch[i];
        if (entry.type === "custom_message" && entry.customType)
          host.messageLanded?.(
            { customType: entry.customType, content: entry.content, details: entry.details },
            (mark) => isMark(mark) && mark.index <= i,
          );
        if (!host.awaitingLanding()) return;
      }
      // Everything up to `end` has been read: a message still waiting lands after it. At
      // `agent_settled` Pi has appended every message it held, so one that has not landed by
      // now never will; it stays open on disk and the next start reports it lost.
      host.reviseLanding?.((mark) =>
        settled || !isMark(mark) ? undefined : { index: end, anchor: branch[end - 1]?.id },
      );
    } catch {}
  };

  /** The transcript position a completion is sent at. */
  const landingMark = (): LandingMark => {
    const branch = (ctxRef as Context).sessionManager.getBranch();
    return { index: branch.length, anchor: branch[branch.length - 1]?.id };
  };

  const store = (ctx: Context): WorkStore => ({
    read: () =>
      ctx.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === WORK_ENTRY)
        .map((entry) => entry.data),
    append: (record: WorkRecord) => pi.appendEntry(WORK_ENTRY, record),
  });

  pi.on("session_start", async (_event, ctx) => {
    remember(ctx);
    const context = ctx as unknown as Context;
    sessionId = context.sessionManager.getSessionId();
    if (isHost(service<unknown>(sessionId, WORK_SERVICE))) return;
    const runtime = createWorkHost({
      store: store(context),
      delivery: transport,
      // Pi holds a message sent mid-run until the turn ends: close the item once it is written.
      confirmLanding: true,
      landingMark,
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
    local = { runtime, withdraw: provide(sessionId, WORK_SERVICE, runtime) };
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

  // `message_end` reaches extensions before Pi writes the message it concerns, so look one
  // macrotask later; the other boundaries come after the end of a turn, where held messages land.
  pi.on("message_end", async (_event, ctx) => {
    remember(ctx);
    if (offered(ctx)?.awaitingLanding?.()) setImmediate(() => checkLanding(ctx));
    return undefined;
  });
  pi.on("turn_start", async (_event, ctx) => {
    checkLanding(ctx);
  });
  pi.on("agent_end", async (_event, ctx) => {
    checkLanding(ctx);
  });
  // The leaf moved: a message sent on the branch it left cannot land on the new one.
  pi.on("session_tree", async (_event, ctx) => {
    remember(ctx);
    checkLanding(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    remember(ctx);
    offered(ctx)?.agentStart?.();
  });
  pi.on("agent_settled", async (_event, ctx) => {
    remember(ctx);
    checkLanding(ctx, true);
    offered(ctx)?.agentSettled?.();
  });
  // A work message that landed after the model's last answer needs one more request in this run.
  pi.on("agent_before_settle", async (event, ctx) => {
    remember(ctx);
    checkLanding(ctx);
    if (event.continue) return undefined; // another handler already asked for it
    return offered(ctx)?.continuesRun?.(event as unknown as BeforeSettleEvent)
      ? { continue: true }
      : undefined;
  });

  pi.on("session_shutdown", async () => {
    checkLanding(ctxRef); // a message already in the transcript closes its item before the host goes
    const mine = local;
    local = undefined;
    if (!mine) return;
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
