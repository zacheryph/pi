/**
 * A real parent session for the characterization tests: this extension is
 * loaded, children are real sessions, and one faux provider answers the parent
 * and every child. The parent is observed only through what it can see: tool
 * results, the messages in its transcript, and the events on its bus.
 */
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, vi, onTestFinished } from "vitest";
import subagentExtension from "#src/index";
import { readPersistedRecords } from "#src/persisted-record";
import {
  agentIdIn,
  BUILTIN_TOOLS,
  CHILD_MARK,
  isChildRequest,
  lastResult,
  offlineAgentDir,
  type Reply,
  scriptSides,
} from "../helpers/sdk.ts";
import {
  fauxSession,
  messageText,
  toolCall,
  toolResults,
} from "../../../../packages/pi-test-helpers/src/faux-session.ts";

/** What one scripted reply may be: a message, or a function of the request it answers. */
export type Step = Reply;

export { CHILD_MARK, isChildRequest };

/**
 * A reply that holds its request open until `release()` is called or the
 * request is aborted, then answers with `reply`. `started` settles once the
 * request has been made, so a test can act on a child known to be mid-run.
 */
export function gated(reply: AssistantMessage = fauxAssistantMessage("(released)")) {
  let release = () => {};
  let begin = () => {};
  const open = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (begin = resolve));
  const step: Step = async (_context, options) => {
    begin();
    await Promise.race([
      open,
      new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve())),
    ]);
    return reply;
  };
  return { step, started, release };
}

/** The retention sweep's interval; the manager registers one `setInterval` at this period. */
const SWEEP_INTERVAL_MS = 60_000;

/** A `subagent_start` call whose child prompt is `prompt`. */
export function delegate(prompt: string, extra: Record<string, unknown> = {}) {
  return toolCall("subagent_start", {
    subagent_type: "general-purpose",
    description: prompt,
    prompt: `${CHILD_MARK} ${prompt}`,
    ...extra,
  });
}

/** A `subagent_send` call that gives agent `id` the message `message`. */
export function sendCall(id: string, message: string) {
  return toolCall("subagent_send", { agent_id: id, message: `${CHILD_MARK} ${message}` });
}

export interface ParentOptions {
  /** Files for the agent directory, such as `subagent.json`. */
  files?: Record<string, string | object>;
  /** Run the parent over this session manager (a reload restores from it). */
  manager?: SessionManager;
  /** An agent directory made earlier, to keep its settings across parents. */
  dir?: string;
}

/** Channels the parent's bus is watched on. */
const WATCHED = [
  "subagent:created",
  "subagent:started",
  "subagent:completed",
  "subagent:failed",
  "subagent:queued",
  "subagent:resuming",
  "subagent:resumed",
  "subagent:steered",
  "subagent:notified",
  "subagent:session:disposed",
];

/**
 * A parent session with `subagent_start`, `subagent_get` and `subagent_send`.
 * Calls to the retention sweep are caught, so a test can run it on demand.
 */
export async function startParent(options: ParentOptions = {}) {
  const dir = options.dir ?? offlineAgentDir({ files: options.files });
  const sweeps: Array<() => void> = [];
  const realSetInterval = globalThis.setInterval;
  const interval = vi.spyOn(globalThis, "setInterval").mockImplementation(((
    fn: () => void,
    ms: number,
    ...rest: unknown[]
  ) => {
    if (ms === SWEEP_INTERVAL_MS) sweeps.push(fn);
    return realSetInterval(fn, ms, ...rest);
  }) as typeof setInterval);
  onTestFinished(() => interval.mockRestore());

  const events: Array<{ channel: string; data: Record<string, unknown> }> = [];
  const manager = options.manager ?? SessionManager.inMemory(dir);
  const h = await fauxSession({
    cleanup: onTestFinished,
    dir,
    provider: "characterization",
    models: [{ id: "worker" }],
    sessionManager: manager,
    // Children take their tools from the parent's, so it offers the built-ins too.
    tools: [...BUILTIN_TOOLS, "subagent_start", "subagent_get", "subagent_send"],
    extensions: [
      subagentExtension,
      (pi) => {
        for (const channel of WATCHED) {
          pi.events.on(channel, (data) =>
            events.push({ channel, data: data as Record<string, unknown> }),
          );
        }
      },
    ],
  });

  /** The calls made to the provider by the parent / by children, oldest first. */
  const requests = { parent: [] as Context[], child: [] as Context[] };

  /**
   * Answer the parent's and the children's requests from two queues (see
   * `scriptSides`). Calling it again starts a new phase: `requests` is emptied
   * and the queues replaced.
   */
  function script(replies: { parent?: Step[]; child?: Step[] }) {
    return scriptSides(h.faux, replies, requests);
  }

  /** The `subagent:completion` and `subagent:update` messages in the transcript, oldest first. */
  const announcements = (customType = "subagent:completion") =>
    manager
      .getEntries()
      .flatMap((entry) =>
        entry.type === "custom_message" && entry.customType === customType
          ? [{ text: messageText(entry), details: entry.details as Record<string, unknown> }]
          : [],
      );

  /** The agent IDs `subagent_start` has announced on this branch, oldest first. */
  const agentIds = () =>
    toolResults(manager, "subagent_start").flatMap((result) => {
      const id = agentIdIn(JSON.stringify(result.content));
      return id ? [id] : [];
    });

  /** The agent's latest saved record on this branch. */
  const savedRecord = (id: string) =>
    readPersistedRecords(manager.getBranch()).find((record) => record.id === id);

  /**
   * Run the retention sweep as if `minutes` had passed since now, then give the
   * releases it started a moment to finish. The sweep fires and forgets each
   * release, so a test that expects none still needs this wait to mean anything.
   */
  async function sweepAfter(minutes: number) {
    const later = Date.now() + minutes * 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      for (const sweep of sweeps) sweep();
    } finally {
      clock.mockRestore();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const seen = (channel: string) => events.filter((event) => event.channel === channel);

  return {
    ...h,
    dir,
    manager,
    events,
    seen,
    requests,
    script,
    announcements,
    agentIds,
    savedRecord,
    sweepAfter,
    lastResult,
  };
}

export type Parent = Awaited<ReturnType<typeof startParent>>;

/** Wait until `count` messages of `customType` are in the parent's transcript. */
export async function untilAnnounced(h: Parent, count = 1, customType = "subagent:completion") {
  await vi.waitFor(() => expect(h.announcements(customType)).toHaveLength(count), {
    timeout: 15_000,
  });
}

/**
 * A tool result or completion message with what varies per run replaced: the
 * agent ID, the transcript path, the tool-call ID and the measured numbers.
 */
export function shape(text: string, id: string): string {
  return text
    .replaceAll(id, "<id>")
    .replace(/\/\S+\.jsonl/g, "<transcript>")
    .replace(/<tool-use-id>[^<]*/g, "<tool-use-id>CALL")
    .replace(/<total_tokens>\d+/g, "<total_tokens>N")
    .replace(/<duration_ms>\d+/g, "<duration_ms>N")
    .replace(/<context_percent>\d+/g, "<context_percent>N");
}
