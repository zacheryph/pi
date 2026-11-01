/**
 * Watch checks that are not shell commands (local addition, see UPSTREAM.md). A probe is an async
 * function; startProbe() runs it with the same contract runCheck() expects from a SupervisedRun:
 * output arrives through onOutput, exactly one outcome through onDone, and terminate() ends the
 * check now (its late result is ignored).
 */
import type { RunOutcome } from "./supervisor.ts";

export interface ProbeResult {
  /** 0 when the check's condition holds, 1 when it does not. Ignored when `error` is set. */
  exitCode: number;
  output: string;
  /** The check could not run (tool error, blocked call, thrown error): inconclusive. */
  error?: string;
  /** End the watch as failed: the check can no longer run (stale session, repeated errors). */
  final?: boolean;
}

export interface WatchProbe {
  run(signal: AbortSignal): Promise<ProbeResult>;
}

export interface ProbeOutcome extends RunOutcome {
  /** The check ran but could not decide: never matches, never sets a baseline. */
  inconclusive?: boolean;
  /** The watch cannot continue; settle it as failed with `error`. */
  final?: boolean;
}

/** What runCheck() needs from a running check. SupervisedRun satisfies it too. */
export interface CheckRun {
  terminate(): void;
  dispose(): void;
}

export function startProbe(
  probe: WatchProbe,
  onOutput: (chunk: Buffer, stream: "out" | "err") => void,
  onDone: (o: ProbeOutcome) => void,
): CheckRun {
  const controller = new AbortController();
  let settled = false;
  const done = (outcome: ProbeOutcome): void => {
    if (settled) return;
    settled = true;
    onDone(outcome);
  };
  void Promise.resolve()
    .then(() => probe.run(controller.signal))
    .then(
      (result) => {
        if (settled) return;
        if (result.output) onOutput(Buffer.from(result.output, "utf8"), "out");
        if (result.error !== undefined)
          done({
            exitCode: null,
            signal: null,
            error: result.error,
            inconclusive: true,
            final: result.final,
          });
        else done({ exitCode: result.exitCode, signal: null });
      },
      (err: unknown) =>
        done({
          exitCode: null,
          signal: null,
          error: err instanceof Error ? err.message : String(err),
          inconclusive: true,
        }),
    );
  return {
    terminate() {
      controller.abort();
      done({ exitCode: null, signal: null });
    },
    dispose() {
      settled = true;
      controller.abort();
    },
  };
}
