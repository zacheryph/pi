/**
 * Watches every run of every child session in a test and reports the ones that did not begin
 * through the agent: "no message ever starts an unmanaged run in a child" (roadmap step 9).
 *
 * A managed run is one a `Subagent` drove: its `startRun` admits it through the concurrency
 * limiter and then calls the child's `runTurnLoop` / `resumeTurnLoop`, whose `driveTurns` awaits
 * `session.prompt`, which starts the run. Anything else that starts a run in a child session (a
 * message sent with `triggerTurn: true`, `sendUserMessage`, a queued follow-up) reaches Pi's
 * `_startRun` from somewhere else, and is recorded as unmanaged here.
 *
 * Children are told from the root session by the parent link in their session header, and a run
 * by whether `driveTurns` is on its (async) call stack, so the check holds for the children of a
 * child too, whose extension is a separate module instance a prototype spy would not reach.
 * Install it before the sessions are created; it undoes itself when the test ends.
 */
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, onTestFinished, vi } from "vitest";

export interface RunLog {
  /** Runs the agent drove, in the order they began. */
  managed: number;
  /** Runs nothing drove: the trigger kind of each. */
  unmanaged: string[];
}

interface StartRunTrigger {
  messageType?: string;
  message?: { customType?: string };
}

type StartRun = (trigger: StartRunTrigger, onStarted?: () => void) => Promise<unknown>;

/** Whether `session` is a child: its header names the session that spawned it. */
function isChild(session: AgentSession): boolean {
  const header = session.sessionManager.getHeader();
  return !!header?.parentSession;
}

export function trackChildRuns(): RunLog {
  const log: RunLog = { managed: 0, unmanaged: [] };
  const prototype = AgentSession.prototype as unknown as { _startRun: StartRun };
  const startRun = prototype._startRun;
  const spy = vi.spyOn(prototype, "_startRun").mockImplementation(function (
    this: AgentSession,
    trigger: StartRunTrigger,
    onStarted?: () => void,
  ) {
    if (isChild(this)) {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 100;
      const stack = new Error("run").stack ?? "";
      Error.stackTraceLimit = limit;
      if (/SubagentSession\.driveTurns/.test(stack)) log.managed++;
      else log.unmanaged.push(trigger.message?.customType ?? trigger.messageType ?? "unknown");
    }
    return startRun.call(this, trigger, onStarted);
  });
  onTestFinished(() => spy.mockRestore());
  return log;
}

/** Fail the test if a child ever ran without its agent driving it. */
export function expectNoUnmanagedRuns(log: RunLog): void {
  expect(log.unmanaged, "runs that began in a child session without its agent").toEqual([]);
}
