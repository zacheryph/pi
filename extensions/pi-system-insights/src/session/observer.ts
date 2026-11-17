import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SESSION_VIEW_ID, viewRegistry, type SessionModel } from "#surface";
import { ActivityTracker } from "#src/session/activity";
import { openForm, watchForms } from "#src/session/forms";
import { buildSessionModel } from "#src/session/model";
import { StatusTracker } from "#src/session/status";
import { UsageCache } from "#src/session/usage";

export interface SessionObserverOptions {
  /** Clock for status and activity times. Default `Date.now`. */
  now?: () => number;
  /** When the Pi process started, epoch milliseconds. Default: from `process.uptime()`. */
  startedAt?: number;
  /** Pi's version; pass `undefined` explicitly for none. Default: the running Pi's. */
  piVersion?: string | undefined;
}

/**
 * Observe this session's core state and publish it as the `system.session`
 * view on the session's own bus, in every UI mode and whether or not any
 * adapter (dashboard, bb) is loaded. A subagent child runs its own copy of the
 * extension on its own bus, so it gets its own observer: nothing is
 * process-global.
 *
 * Status and activity are process-bound and start over at every
 * `session_start` (startup, reload, /new, /resume, /fork); usage totals are
 * rebuilt from the session file and cached until its history changes. Reading
 * the view is pure: it builds the model from the current context and the
 * trackers, and announces nothing.
 */
export function observeSession(pi: ExtensionAPI, options: SessionObserverOptions = {}): void {
  const now = options.now ?? Date.now;
  const startedAt = options.startedAt ?? Math.round(Date.now() - process.uptime() * 1000);
  const piVersion = "piVersion" in options ? options.piVersion : VERSION;
  // Defined from session_start to session_shutdown, so a /reload, which runs the
  // factory again on the same bus, never leaves a second provider behind.
  const views = viewRegistry(pi.events);
  const usage = new UsageCache();
  let status = new StatusTracker(now);
  let activity = new ActivityTracker(now);
  let current: ExtensionContext | undefined;
  let unwatchForms: (() => void) | undefined;

  const changed = () => views.changed(SESSION_VIEW_ID);
  /** An event that may change what the view shows; later reads use this context. */
  const update = (ctx: ExtensionContext) => {
    current = ctx;
    changed();
  };
  /**
   * The session's history changed or is about to: usage totals are scanned
   * again on the next read. Pi appends a message only after the extensions'
   * `message_end` handlers ran; the cache's revision check sees that append.
   */
  const history = (ctx: ExtensionContext) => {
    usage.invalidate();
    update(ctx);
  };

  const read = (): SessionModel | undefined => {
    const ctx = current;
    if (!ctx) return undefined;
    return buildSessionModel({
      ctx,
      name: pi.getSessionName(),
      thinking: pi.getThinkingLevel(),
      status: status.current(),
      activity: activity.list(),
      usage: usage.totals(ctx.sessionManager),
      startedAt,
      piVersion,
    });
  };

  /** Re-read the session's open forms; announce only when the status changes. */
  const refreshForms = () => {
    if (status.setForm(openForm(pi.events, SESSION_VIEW_ID))) changed();
  };

  /** Forget everything process-bound and remove the view, without announcing. */
  const reset = () => {
    unwatchForms?.();
    unwatchForms = undefined;
    views.dispose();
    status = new StatusTracker(now);
    activity = new ActivityTracker(now);
    usage.invalidate();
    current = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    reset();
    current = ctx;
    views.define({ id: SESSION_VIEW_ID, kind: "session", title: "Session", model: read });
    unwatchForms = watchForms(pi.events, SESSION_VIEW_ID, refreshForms);
    // A form defined before this observer started is open already.
    refreshForms();
  });
  pi.on("session_shutdown", () => reset());

  pi.on("session_info_changed", (_event, ctx) => update(ctx));
  pi.on("model_select", (_event, ctx) => update(ctx));
  pi.on("thinking_level_select", (_event, ctx) => update(ctx));
  pi.on("session_tree", (_event, ctx) => history(ctx));
  pi.on("message_end", (_event, ctx) => history(ctx));
  pi.on("turn_end", (_event, ctx) => update(ctx));
  pi.on("agent_start", (_event, ctx) => {
    status.agentStart();
    update(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    status.settled();
    activity.settle();
    update(ctx);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    // Calls made by another tool (codemode scripts) stay under their parent.
    if (event.parentToolCallId) return;
    status.toolStart(event.toolCallId, event.toolName);
    activity.start(event.toolCallId, event.toolName, event.args);
    update(ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (event.parentToolCallId) return;
    status.toolEnd(event.toolCallId);
    activity.end(event.toolCallId, event.isError);
    update(ctx);
  });
  pi.on("session_before_compact", (_event, ctx) => {
    status.compactStart();
    update(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    status.compactEnd();
    history(ctx);
  });
  pi.on("session_compact_failed", (_event, ctx) => {
    status.compactEnd();
    update(ctx);
  });
  pi.on("ui_prompt_start", (event, ctx) => {
    status.promptStart(event.title);
    update(ctx);
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    status.promptEnd();
    update(ctx);
  });
}
