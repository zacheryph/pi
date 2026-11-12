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
 * Two moments have neither: Pi is busy without a run (a compaction, a `/tree` summary), or the run
 * is past its last chance to continue (after the final `agent_before_settle`). The message is in
 * the transcript, but nothing starts a run for it. The root host then owes the session a wake
 * (`owe` below) and pays it once Pi is idle again, with one `WORK_WAKE` message that starts a run.
 * Pi tells extensions nothing when it becomes idle, and only a command context can wait for it, so
 * the host dispatches a command of its own (`WORK_WAKE_COMMAND`) and waits there.
 *
 * Landing (when a completed item's message has reached the transcript) is read by the
 * `LandingTracker` (landing.ts) of the instance that provided the host, and by no other: an
 * instance that only finds a host forwards the run boundaries and reads nothing.
 */
import { readEntries } from "#session-state";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { provide, service } from "#session-tree";
import {
  WORK_ENTRY,
  WORK_SERVICE,
  WORK_WAKE,
  WORK_WAKE_COMMAND,
  type WorkHost,
  type WorkMessage,
  type WorkRecord,
} from "#src/contract";
import type { BeforeSettleEvent, DeliveryHost } from "#src/delivery";
import { createWorkHost, type WorkHostRuntime, type WorkStore } from "#src/host";
import { createLandingTracker, type LandingTracker } from "#src/landing";

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

/** What the wake message tells the model. The results are the work messages before it. */
export const WAKE_TEXT =
  "Background work reported back while Pi was busy, so nothing answered it yet. " +
  "Its messages are above in the conversation. Handle them and continue.";

/** The slice of a command context the wake command reads. */
interface CommandContext {
  waitForIdle?(): Promise<void>;
  ui?: { notify?(message: string, level?: "info" | "warning" | "error"): void };
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

  // ---- The wake the root host owes (see the file comment) ----
  /** A work message is in the transcript that no run was started for and no active run will see. */
  let owed = false;
  /** Pi was busy without a run when the wake became owed, or a compaction began after it. */
  let busy = false;
  /** That compaction succeeded. One that failed or was cancelled is decided by its own event. */
  let compacted = false;
  /** The wake command is waiting for Pi to be idle. */
  let waiting = false;
  /** Between `agent_start` and `agent_settled`. */
  let runActive = false;
  /** The outcome the run's last `agent_before_settle` reported; undefined when it had none. */
  let lastOutcome: string | undefined;
  /** The startup's lost message is being written: it never wakes anything. */
  let settling = false;
  /** The wake command is registered in this extension instance. */
  let hasCommand = false;
  /** Counts session instances and branches, so a wait that outlives one pays nothing. */
  let generation = 0;

  const idle = (): boolean => {
    try {
      return typeof ctxRef?.isIdle === "function" && ctxRef.isIdle();
    } catch {
      return false; // a stale context
    }
  };
  const forget = () => {
    owed = false;
    busy = false;
    compacted = false;
  };
  /** Start the run, if the wake is still owed and Pi can take it now. */
  const pay = () => {
    if (!local || !owed || !idle()) return;
    // A compaction that did not succeed: `session_compact_failed` says whether it was cancelled.
    if (busy && !compacted) return;
    forget();
    try {
      pi.sendMessage(
        { customType: WORK_WAKE, content: WAKE_TEXT, display: true },
        { triggerTurn: true },
      );
    } catch {
      // A stale context: the messages stay in the transcript for the next prompt.
    }
  };
  /**
   * Pay one event-loop turn later. A prompt submitted at the same boundary (one the user queued
   * during the compaction) starts first, and its `input` event cancels the wake: its run answers.
   */
  const paySoon = () => {
    const mine = generation;
    setImmediate(() => {
      if (mine === generation) pay();
    });
  };
  /** A wake is owed: wait for Pi to be idle, in the wake command. */
  const owe = () => {
    if (!local) return;
    owed = true;
    if (waiting) return;
    // Without the command the text would be sent to the model as a prompt.
    if (!hasCommand || typeof pi.sendUserMessage !== "function") return paySoon();
    waiting = true;
    try {
      pi.sendUserMessage(`/${WORK_WAKE_COMMAND}`, { expandPromptTemplates: true });
    } catch {
      waiting = false;
    }
  };
  const registerWakeCommand = () => {
    if (hasCommand || typeof pi.registerCommand !== "function") return;
    try {
      pi.registerCommand(WORK_WAKE_COMMAND, {
        description: "Answer background work that reported back while Pi was busy (automatic)",
        handler: async (_args: string, ctx: unknown) => {
          const command = ctx as CommandContext;
          if (!waiting) {
            command.ui?.notify?.(
              owed
                ? "pi-work: the work that reported back is answered when Pi is idle."
                : "pi-work: no work is waiting for an answer.",
              "info",
            );
            return;
          }
          const mine = generation;
          try {
            await command.waitForIdle?.();
          } finally {
            if (mine === generation) waiting = false;
          }
          if (mine === generation) paySoon();
        },
      });
      hasCommand = true;
    } catch {
      // Without it the wake is paid only when Pi is already idle.
    }
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
      // Busy without a run (a compaction, a `/tree` summary): recorded, and nothing follows it.
      if (mode === "record" && !settling && !runActive && !idle()) {
        busy = true;
        owe();
      }
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
    generation++;
    forget();
    waiting = false;
    runActive = false;
    lastOutcome = undefined;
    if (isHost(service<unknown>(sessionId, WORK_SERVICE))) return;
    registerWakeCommand();
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
    settling = true;
    try {
      local?.runtime.settleStartup();
    } finally {
      settling = false;
    }
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
  // The leaf moved: a message sent on the branch it left cannot land on the new one, and a wake
  // owed for the branch it left is not owed on this one.
  pi.on("session_tree", async (_event, ctx) => {
    remember(ctx);
    local?.landing.observe("session_tree");
    generation++;
    forget();
  });

  // A compaction decides a wake owed across it: paid after one that succeeded or failed, dropped
  // after one that was cancelled (Escape, or an extension's `cancel`), like an aborted run.
  pi.on("session_before_compact", async () => {
    if (owed) busy = true;
    return undefined;
  });
  pi.on("session_compact", async () => {
    if (owed) compacted = true;
  });
  pi.on("session_compact_failed", async (event, ctx) => {
    remember(ctx);
    if (!owed) return;
    if (event.aborted) return forget();
    // Pi is idle by now, unless a run is waiting to retry.
    busy = false;
    if (!waiting) paySoon();
  });
  // A prompt is on its way to a run, which sees the transcript: no wake is owed beside it.
  pi.on("input", async () => {
    forget();
    return undefined;
  });

  pi.on("agent_start", async (_event, ctx) => {
    remember(ctx);
    runActive = true;
    lastOutcome = undefined;
    forget(); // this run sees whatever a wake was owed for
    offered(ctx)?.agentStart?.();
  });
  pi.on("agent_settled", async (event, ctx) => {
    remember(ctx);
    runActive = false;
    local?.landing.observe("agent_settled");
    offered(ctx)?.agentSettled?.();
    // A message that landed after this run's last chance to continue (between its final
    // `agent_before_settle` and now) found a run active, so nothing woke the session for it.
    // Only after a run that completed: a stopped one answers nothing, a failed one would repeat.
    const mine = local;
    if (
      mine &&
      !event.aborted &&
      lastOutcome === "completed" &&
      mine.landing.unanswered((customType) => mine.runtime.delivers(customType))
    )
      owe();
  });
  // A work message that landed after the model's last answer needs one more request in this run.
  pi.on("agent_before_settle", async (event, ctx) => {
    remember(ctx);
    lastOutcome = event.outcome;
    local?.landing.observe("agent_before_settle");
    if (event.continue) return undefined; // another handler already asked for it
    return offered(ctx)?.continuesRun?.(event as unknown as BeforeSettleEvent)
      ? { continue: true }
      : undefined;
  });

  pi.on("session_shutdown", async () => {
    generation++;
    forget();
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
