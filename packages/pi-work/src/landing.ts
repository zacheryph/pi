/**
 * Landing: when does a work message reach the transcript?
 *
 * Pi holds a message sent mid-run (`triggerTurn: false`) and appends it at the end of the current
 * turn, and tells extensions nothing when it does. A host that wants an item closed only once its
 * result is in the transcript (`WorkHostOptions.confirmLanding`) therefore reads the transcript
 * itself: right after a send and at the run boundaries that follow the end of a turn. That check
 * is this tracker. Every host that holds messages uses the same one, whoever provides it: the
 * root session's host (`ensureWorkHost`) and a managed child's (pi-subagent's `ChildWork`) differ
 * only in where the transcript and the run boundaries come from.
 *
 * Exactly one tracker serves a host: the one made by whoever provides the host, who passes its
 * `mark` as the host's `landingMark` and reports the boundaries to it. Anyone else who merely
 * forwards boundaries to a host (an extension in a managed child) holds no tracker and reads no
 * landing: marks share one shape and belong to the host, so a second reader would not corrupt
 * them, but it would read the transcript twice per boundary for nothing.
 *
 * The tracker also answers a second transcript question for the managed child: does the
 * transcript end with a delivered message nobody answered (`unanswered`)?
 */
import type { WorkHostRuntime } from "#src/host";

/** The slice of a transcript entry the tracker reads. */
export interface TranscriptEntry {
  id?: string;
  type: string;
  customType?: string;
  content?: unknown;
  details?: unknown;
}

/** The host side of landing: the methods of `WorkHostRuntime` the tracker calls. */
export type LandingTarget = Pick<
  WorkHostRuntime,
  "awaitingLanding" | "landingMarks" | "reviseLanding" | "messageLanded"
>;

/**
 * Where the transcript stood when a completion was sent: its message can only be an entry at
 * `index` or later. `anchor` is the id of the entry before it, to notice that the leaf moved to
 * another branch.
 */
export interface LandingMark {
  index: number;
  anchor: string | undefined;
}

/** The run boundaries, named as both Pi's extension events and its session events name them. */
export type LandingBoundary =
  | "message_end"
  | "turn_start"
  | "agent_end"
  | "agent_before_settle"
  | "agent_settled"
  | "session_tree"
  | "session_shutdown";

export interface LandingTrackerOptions {
  /** The transcript's current branch, oldest entry first. May throw (a stale context). */
  branch(): readonly TranscriptEntry[];
  /** The host to report to; undefined when it is gone. */
  target(): LandingTarget | undefined;
}

export interface LandingTracker {
  /** Pass as `WorkHostOptions.landingMark`: the transcript position a completion is sent at. */
  mark(): LandingMark;
  /**
   * A message was just handed to Pi. It is appended at once when Pi is neither streaming nor
   * starting a run for it, so look one microtask later (not inside the host's own `complete`).
   */
  sent(): void;
  /** Report a run boundary. Only the ones that can have appended a held message read anything. */
  observe(boundary: LandingBoundary): void;
  /**
   * Which of the host's completed items have their message in the transcript now. `settled`: a
   * run has settled, so a message that has not landed by now never will.
   */
  check(settled?: boolean): void;
  /**
   * Whether a message `delivers` recognizes by custom type has no answer after it: walking back
   * from the end, custom messages of other types, records, labels and branch summaries are skipped,
   * and the first delivered message found before any message or compaction entry is unanswered.
   */
  unanswered(delivers: (customType: string) => boolean): boolean;
  /** Stop reading: the transcript is going away. */
  dispose(): void;
}

/** How many of the newest transcript entries are read to find a message that has landed. */
const LANDING_SCAN = 1000;

const isMark = (mark: unknown): mark is LandingMark =>
  typeof (mark as LandingMark | undefined)?.index === "number";

export function createLandingTracker(options: LandingTrackerOptions): LandingTracker {
  let disposed = false;

  const check = (settled = false): void => {
    if (disposed) return;
    try {
      const host = options.target();
      if (!host?.awaitingLanding()) return;
      const branch = options.branch();
      const end = branch.length;
      // A message sent on a branch the leaf has left cannot land on this one.
      host.reviseLanding((mark) =>
        isMark(mark) && (mark.index === 0 || branch[mark.index - 1]?.id === mark.anchor)
          ? mark
          : undefined,
      );
      const first = Math.min(
        ...host.landingMarks().map((mark) => (isMark(mark) ? mark.index : end)),
      );
      // Oldest entry first, so identical messages are taken in the order they were sent, and
      // only entries after the mark: an identical message that landed earlier is not this one.
      for (let i = Math.max(first, end - LANDING_SCAN, 0); i < end; i++) {
        const entry = branch[i];
        if (entry.type === "custom_message" && entry.customType)
          host.messageLanded(
            { customType: entry.customType, content: entry.content, details: entry.details },
            (mark) => isMark(mark) && mark.index <= i,
          );
        if (!host.awaitingLanding()) return;
      }
      // Everything up to `end` has been read: a message still waiting lands after it. At
      // `agent_settled` Pi has appended every message it held, so one that has not landed by
      // now never will; it stays open on disk and the next start reports it lost.
      host.reviseLanding((mark) =>
        settled || !isMark(mark) ? undefined : { index: end, anchor: branch[end - 1]?.id },
      );
    } catch {
      // A stale context cannot be read; the item stays open on disk and is reported lost.
    }
  };

  return {
    mark: () => {
      const branch = options.branch();
      return { index: branch.length, anchor: branch[branch.length - 1]?.id };
    },
    sent: () => queueMicrotask(() => check()),
    observe: (boundary) => {
      switch (boundary) {
        case "message_end":
          // The event reaches listeners before Pi writes the message it concerns, so look one
          // macrotask later.
          if (!disposed && options.target()?.awaitingLanding())
            setImmediate(() => {
              check();
            });
          return;
        case "agent_settled":
          check(true);
          return;
        default:
          check();
      }
    },
    check,
    unanswered: (delivers) => {
      try {
        const branch = options.branch();
        for (let i = branch.length - 1; i >= 0; i--) {
          const entry = branch[i];
          // Another extension's custom message after the work message does not answer it.
          if (entry.type === "custom_message") {
            if (entry.customType && delivers(entry.customType)) return true;
            continue;
          }
          // A message (answer, prompt, tool result) or a compaction ends the search; records,
          // labels and branch summaries are not an answer and are skipped.
          if (entry.type === "message" || entry.type === "compaction") return false;
        }
      } catch {
        // Unreadable: assume nothing is waiting rather than start a run on a guess.
      }
      return false;
    },
    dispose: () => {
      disposed = true;
    },
  };
}
