import type { ChildShutdownReason } from "#src/lifecycle/child-shutdown";
import type { SessionContext } from "#src/types";

/**
 * Session lifecycle event handlers: session_start, session_before_switch, session_shutdown.
 *
 * Extracted from index.ts so each handler can be tested in isolation
 * with mocked narrow interfaces.
 */

/** Narrow manager interface — only the methods lifecycle handlers call. */
export interface LifecycleManager {
  clearCompleted(): Promise<void>;
  suspend(): void;
  dispose(reason?: ChildShutdownReason): Promise<void>;
}

/** Narrow runtime interface — only the methods lifecycle handlers call. */
export interface LifecycleRuntime {
  setSessionContext(ctx: SessionContext): void;
  clearSessionContext(): void;
}

/**
 * Handles session lifecycle events.
 *
 * Constructor deps:
 * - `runtime` — owns session context state
 * - `manager` — manages agent lifecycle (clear, abort, dispose)
 * - `disposeWork` — makes the spawner's work items inert on shutdown (they stay open)
 * - `isChild` — whether the session is a delegated one, which has a delegator above it
 */
export class SessionLifecycleHandler {
  constructor(
    private readonly runtime: LifecycleRuntime,
    private readonly manager: LifecycleManager,
    private readonly disposeWork: () => void,
    private readonly isChild: () => boolean = () => false,
  ) {}

  handleSessionStart(_event: unknown, ctx: unknown): Promise<void> {
    this.runtime.setSessionContext(ctx as SessionContext);
    return this.manager.clearCompleted();
  }

  handleSessionBeforeSwitch(): Promise<void> {
    return this.manager.clearCompleted();
  }

  // What a shutdown does, by why the session ends (roadmap step 12):
  //
  // - Agents are never stopped for it. A run in flight or queued is cut short and is recorded as
  //   `interrupted`; an agent waiting on work stays waiting, with its items open in its own
  //   transcript. The next start of this session (`StartupRestore`) reopens the agents that had
  //   work and lets the producers take it over, or reports it lost. Nothing is called off here,
  //   so a stop stays the only thing that cancels an agent's work.
  // - `reload` is the same process starting again: the children are told so, and pi-job keeps
  //   their jobs for the sessions it reopens. Every other reason (`quit`, and `new`, `resume` and
  //   `fork`, which replace the session) ends the children's extensions for good: their jobs die,
  //   and the next start of this session finds the items open and reports them lost, while a
  //   question is still adopted.
  // - A delegated session's own subagents end with it, whatever the reason: a reload of its parent
  //   is not one for them (they are not restored), so they are told `quit`.
  //
  // Cleanup order matters:
  // 1. Clear session context — no more session state
  // 2. Dispose the work items — silence them *before* the interruptions that would
  //    end them: a run cut short by the shutdown must not close its item or send
  //    a message, so the item stays open and the next start adopts it or reports it lost
  // 3. Suspend all agents — interrupt running and queued work, leave waiting work alone
  // 4. Dispose manager — final cleanup, awaited so each child's extensions get
  //    their `session_shutdown` before Pi tears the parent down (#709)
  handleSessionShutdown(event?: { reason?: string }): Promise<void> {
    // Before the context goes: whether the session is a delegated one is read from it.
    const reload = event?.reason === "reload" && !this.isChild();
    this.runtime.clearSessionContext();
    this.disposeWork();
    this.manager.suspend();
    return this.manager.dispose(reload ? "reload" : "quit");
  }
}
