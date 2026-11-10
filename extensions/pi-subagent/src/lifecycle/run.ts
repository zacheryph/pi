/**
 * run.ts — Run: everything one execution of a Subagent owns.
 *
 * An agent's record outlives its runs: the first run and every resume are
 * separate executions, each with its own cancel lever, listener handles and
 * run promise. `Subagent.startRun` mints one `Run` per execution, so that state
 * is replaced as a unit when the next run starts instead of being reset field
 * by field on the record.
 */

import { RunListeners } from "#src/lifecycle/run-listeners";
import type { SubagentSession } from "#src/lifecycle/subagent-session";
import type { RunConfig } from "#src/runtime";

/**
 * What a run does with the agent's session, and how observers hear about it.
 *
 * - `initial`: the spawn's first run. Creates the session; announced as a start.
 * - `resume`: continues the session, live or reopened from its transcript;
 *   announced as a resume.
 * - `relaunch`: the first run of an agent that never got a session (it was
 *   stopped while queued, or its session could not be created) and has now been
 *   sent a message. Creates the session like `initial`, from the agent's
 *   original spawn configuration, but is announced as a resume: the agent
 *   already had a record, and a consumer counting starts must not see it twice.
 */
export type RunKind = "initial" | "resume" | "relaunch";

/**
 * How a run is admitted. Receives the run's body and returns the promise for the
 * whole run, starting the body now or when a scheduler (the limiter) grants a
 * slot. A run started without an admission begins at once.
 */
export type Admission = (begin: () => Promise<void>) => Promise<void>;

export interface RunInit {
  kind: RunKind;
  /** The prompt the turn loop starts from. */
  prompt: string;
  /**
   * A caller's signal. It is wired to the record's `abort()` rather than
   * forwarded to the turn loop, so every lever stops the same run the same way.
   */
  signal?: AbortSignal;
  /** A resume only: the session still attached, when the record has not released it. */
  liveSession?: SubagentSession;
  /**
   * A resume only: the turn ceiling carried over from the runs before it,
   * including 0 for unlimited.
   */
  turnCeiling?: number;
}

export class Run {
  readonly kind: RunKind;
  private text: string;
  readonly signal?: AbortSignal;
  readonly liveSession?: SubagentSession;
  /** Resolved ceiling a cold resume reopens its session with; undefined, the spawn's own. */
  readonly turnCeiling?: number;

  /** Cancels this run. A new run gets its own, so a record stopped once can run again. */
  readonly abort = new AbortController();
  /** The run's observer and signal handles, released together when it ends. */
  readonly listeners = new RunListeners();
  /**
   * The prompt the turn loop starts from: what the run was created with, then
   * any message sent while the run was still waiting for its slot.
   */
  get prompt(): string {
    return this.text;
  }

  /**
   * Fold a message into a run that has not begun, after what it will start
   * from. It reaches the agent as part of the run's first prompt, so it needs no
   * session, and a run that is stopped before its slot opens takes it along.
   */
  addMessage(message: string): void {
    this.text = joinPrompt(this.text, message);
  }

  /** Settles when the run reaches a terminal state. Always resolves. */
  promise?: Promise<void>;
  /**
   * The run is creating or reopening the agent's session and has not got it yet.
   * A run stopped in this window winds down on its own: the session it was
   * building is disposed when it arrives, and until then no second one may be
   * started for the agent (a stopped rebuild still owns the transcript).
   */
  opening = false;
  /**
   * The run's prompt is, or contains, the parent's message: it answers the questions the agent
   * asked, so they close when the run has the agent's session (see `Subagent.send`).
   */
  answering = false;
  /** What the initial run's session factory was configured with; read for its turn loop. */
  runConfig?: RunConfig;

  constructor(init: RunInit) {
    this.kind = init.kind;
    this.text = init.prompt;
    this.signal = init.signal;
    this.liveSession = init.liveSession;
    this.turnCeiling = init.turnCeiling;
  }
}

/** A prompt followed by a message sent after it, as separate paragraphs. */
export function joinPrompt(prompt: string, message: string): string {
  return `${prompt}\n\n${message}`;
}

/**
 * The prompt of a run the work host asked for: work an idle agent waited on reported back.
 *
 * The messages themselves are already in the transcript, where the host wrote them, so the run
 * "starts from the transcript as it stands". The roadmap preferred starting it with the newest
 * message as the trigger (`sendCustomMessage(..., { triggerTurn: true })`, as the root does), and
 * the turn-budget wrapper could drive that: the call returns when the run is over. A fixed
 * prompt was chosen instead because the run waits for a concurrency slot:
 *
 *  - A trigger message is appended when the run starts, so while the run is queued it would
 *    exist only in memory. A fixed prompt keeps the invariant that the transcript is the inbox:
 *    the host writes every message at once, closes its item once the message is in the
 *    transcript, and a crash or a stop while queued loses nothing.
 *  - Messages that arrive while the run is queued are appended at once too, so they keep their
 *    order; a held trigger would land after them.
 *  - A message from the parent that joins the queued run (`Run.addMessage`) simply follows this
 *    prompt, with no second mechanism for merging a trigger with a prompt.
 *
 * The cost is one short user message in the child's transcript per wake.
 */
export const WORK_WAKE_PROMPT =
  "Work you were waiting on has reported back. The messages are above in your conversation. " +
  "Handle them and continue your assignment.";
