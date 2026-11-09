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

/** The first run creates the session; a resume continues one. */
export type RunKind = "initial" | "resume";

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
  readonly prompt: string;
  readonly signal?: AbortSignal;
  readonly liveSession?: SubagentSession;
  /** Resolved ceiling a cold resume reopens its session with; undefined, the spawn's own. */
  readonly turnCeiling?: number;

  /** Cancels this run. A new run gets its own, so a record stopped once can run again. */
  readonly abort = new AbortController();
  /** The run's observer and signal handles, released together when it ends. */
  readonly listeners = new RunListeners();
  /** Settles when the run reaches a terminal state. Always resolves. */
  promise?: Promise<void>;
  /** A cold resume is rebuilding the session; a stopped rebuild still owns the transcript. */
  reopening: boolean;
  /** What the initial run's session factory was configured with; read for its turn loop. */
  runConfig?: RunConfig;

  constructor(init: RunInit) {
    this.kind = init.kind;
    this.prompt = init.prompt;
    this.signal = init.signal;
    this.liveSession = init.liveSession;
    this.turnCeiling = init.turnCeiling;
    this.reopening = init.kind === "resume" && init.liveSession === undefined;
  }
}
