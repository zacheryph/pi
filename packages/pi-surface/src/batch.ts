import type { ActionBus } from "#src/actions";
import { onViewChanged } from "#src/views";

// The adapter's side of view announcements: many announcements in a burst
// become one collection. Nothing here knows a transport.

/** The timer functions a batcher uses; tests pass fakes. Defaults to the global ones. */
export interface BatchTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const globalTimers: BatchTimers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms) as unknown as { unref?: () => void };
    // A pending flush never keeps the process alive on its own.
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

export interface ViewBatchOptions {
  /**
   * Collect and send. Called once when the batcher starts, then once after
   * each burst. A failure to send is the adapter's to report here; the
   * batcher only coalesces.
   */
  flush: () => void;
  /** How long after the first announcement of a burst the flush runs. */
  delayMs: number;
  timers?: BatchTimers;
  /** Receives what `flush` throws; otherwise it is dropped so the timer cannot crash Pi. */
  onError?: (error: unknown) => void;
}

export interface ViewBatcher {
  /** Ask for a flush after the delay, joining one already pending; for the adapter's own triggers. */
  schedule(): void;
  /** Flush now, replacing a pending one. Does nothing once disposed. */
  flushNow(): void;
  /** Stop listening and cancel a pending flush; no flush runs afterwards. Idempotent. */
  dispose(): void;
  readonly disposed: boolean;
}

/**
 * Batch view announcements on `bus` into flushes. Call it once the consumer's
 * connection is ready: it subscribes, then flushes at once, before it
 * returns, so the first delivery is a complete read of the registry and no
 * announcement made after setup is lost. Each later announcement starts the
 * delay unless a flush is already pending, so a burst gives one flush no later
 * than `delayMs` after it began. Dispose it when the connection closes.
 */
export function batchViews(bus: ActionBus, options: ViewBatchOptions): ViewBatcher {
  const timers = options.timers ?? globalTimers;
  let pending: { handle: unknown } | undefined;
  let disposed = false;

  const cancel = () => {
    if (pending) timers.clearTimeout(pending.handle);
    pending = undefined;
  };
  const run = () => {
    if (disposed) return;
    cancel();
    try {
      options.flush();
    } catch (error) {
      options.onError?.(error);
    }
  };
  const schedule = () => {
    if (disposed || pending) return;
    const slot: { handle: unknown } = { handle: undefined };
    pending = slot;
    slot.handle = timers.setTimeout(() => {
      // A timer that fires after its cancellation, or after dispose, does nothing.
      if (pending !== slot) return;
      pending = undefined;
      run();
    }, options.delayMs);
  };
  const off = onViewChanged(bus, schedule);

  const batcher: ViewBatcher = {
    schedule,
    flushNow: run,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      try {
        off();
      } catch {
        // Unsubscribing from a bus Pi has retired has nothing left to remove.
      }
    },
    get disposed() {
      return disposed;
    },
  };
  run();
  return batcher;
}
