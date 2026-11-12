// Loaded by midrun-delivery-sdk.test.ts, in the parent (so children inherit its tool) and as an
// extension of every child: a work producer a test drives by hand.
//
//  - `probe_open` opens an item (owner "probe") in the calling session's work host.
//  - The test completes or notifies it through `probe()`, at a moment it chooses: while the child
//    is held in a model request, or from a hook that runs inside a run boundary, which is how a
//    message is made to arrive after the run's last chance to continue.
//
// Hooks run only in a session that opened an item, so the parent never triggers them. List this
// extension FIRST in the agent directory's extensions: its handlers then run before any work host
// has heard that a boundary was reached (each extension's `ensureWorkHost` forwards it to the
// host), which is how a message is made to arrive in the last moments of a run, while the host
// still counts the run as active.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ensureWorkHost } from "#work";
import type { WorkItem, WorkMessage } from "#work";

export const PROBE = Symbol.for("pi-subagent.test.work-probe");

export interface Probe {
  /** Items opened by `probe_open`, by label. */
  items: Map<string, WorkItem>;
  /** Runs inside `agent_before_settle`, before the work hosts' handlers (the message is pending for them). */
  beforeSettle?: (event: { outcome: string }) => void;
  /** Runs inside `agent_settled`, before the work hosts hear the run is over. */
  settled?: () => void;
  /** Runs inside `turn_end`. */
  turnEnd?: () => void;
  /** The session file of the session that opened an item (what a crash leaves behind, copied). */
  file?: string;
  /** Starts a run in the session that opened an item, as an extension that sends a trigger would. */
  triggerRun?: (content: string) => void;
  /** Sends another extension's custom message (not work) into the session that opened an item. */
  sendNote?: (content: string) => void;
  /** How often each hook ran. */
  seen: { beforeSettle: number; settled: number; turnEnd: number };
  complete(label: string, content: string, customType?: string): void;
  notify(label: string, content: string, customType?: string): void;
}

const slots = globalThis as Record<symbol, unknown>;

/** The probe of this process; created by whichever session loads the fixture first. */
export function probe(): Probe {
  return (slots[PROBE] ??= {
    items: new Map(),
    seen: { beforeSettle: 0, settled: 0, turnEnd: 0 },
    complete(label: string, content: string, customType = "probe:done") {
      const message: WorkMessage = { customType, content };
      this.items.get(label)?.complete(message);
    },
    notify(label: string, content: string, customType = "probe:update") {
      this.items.get(label)?.notify({ customType, content });
    },
  } satisfies Probe) as Probe;
}

export default function workProbe(pi: ExtensionAPI): void {
  const work = ensureWorkHost(pi);
  const state = probe();
  let opened = false;
  pi.registerTool({
    name: "probe_open",
    label: "probe_open",
    description: "Open a work item the test completes later.",
    parameters: Type.Object({ label: Type.String() }),
    execute: async (_id, params, _signal, _update, ctx) => {
      state.file = ctx.sessionManager.getSessionFile();
      state.triggerRun = (content) =>
        pi.sendMessage(
          { customType: "probe:trigger", content, display: true },
          { triggerTurn: true },
        );
      state.sendNote = (content) =>
        pi.sendMessage(
          { customType: "other:note", content, display: true },
          { triggerTurn: false },
        );
      state.items.set(
        params.label,
        work.host()!.open({ owner: "probe", kind: "job", label: params.label }),
      );
      opened = true;
      return { content: [{ type: "text" as const, text: `opened ${params.label}` }], details: {} };
    },
  });
  pi.on("agent_before_settle", (event) => {
    if (!opened) return undefined;
    state.seen.beforeSettle++;
    state.beforeSettle?.(event as unknown as { outcome: string });
    return undefined;
  });
  pi.on("agent_settled", () => {
    if (!opened) return;
    state.seen.settled++;
    state.settled?.();
  });
  pi.on("turn_end", () => {
    if (!opened) return;
    state.seen.turnEnd++;
    state.turnEnd?.();
  });
}
