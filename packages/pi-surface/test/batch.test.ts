import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeEventBus } from "#test-helpers";
import { announceView, batchViews, type BatchTimers } from "#src/index";

/** Timers that run only when the test says so. */
function manualTimers() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 0;
  const timers: BatchTimers = {
    setTimeout(callback, ms) {
      pending.set(++next, { callback, ms });
      return next;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    pending,
    /** Run the timers pending now, as the event loop would; timers they set wait. */
    runAll() {
      const due = Array.from(pending.entries());
      for (const [handle, { callback }] of due) {
        if (!pending.delete(handle)) continue;
        callback();
      }
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("batchViews", () => {
  it("flushes once at start, then once per burst of announcements", () => {
    const bus = fakeEventBus();
    const clock = manualTimers();
    const flush = vi.fn();
    const batcher = batchViews(bus, { flush, delayMs: 50, timers: clock.timers });
    // The initial complete read happens before batchViews returns.
    expect(flush).toHaveBeenCalledTimes(1);
    announceView(bus, "todo.widget");
    announceView(bus, "todo.explorer");
    announceView(bus, "todo.widget");
    expect(clock.pending.size).toBe(1);
    expect([...clock.pending.values()][0]!.ms).toBe(50);
    expect(flush).toHaveBeenCalledTimes(1);
    clock.runAll();
    expect(flush).toHaveBeenCalledTimes(2);
    // The adapter's own triggers join the same batch.
    batcher.schedule();
    announceView(bus, "todo.widget");
    clock.runAll();
    expect(flush).toHaveBeenCalledTimes(3);
    batcher.dispose();
  });

  it("subscribes before the initial read, so an announcement made during it is not lost", () => {
    const bus = fakeEventBus();
    const clock = manualTimers();
    let first = true;
    const flush = vi.fn(() => {
      if (first) announceView(bus, "todo.widget");
      first = false;
    });
    batchViews(bus, { flush, delayMs: 10, timers: clock.timers });
    clock.runAll();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("flushNow replaces a pending flush", () => {
    const bus = fakeEventBus();
    const clock = manualTimers();
    const flush = vi.fn();
    const batcher = batchViews(bus, { flush, delayMs: 10, timers: clock.timers });
    announceView(bus, "todo.widget");
    batcher.flushNow();
    expect(clock.pending.size).toBe(0);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("never flushes once disposed, even when a timer fires late", () => {
    const bus = fakeEventBus();
    const clock = manualTimers();
    const flush = vi.fn();
    const batcher = batchViews(bus, { flush, delayMs: 10, timers: clock.timers });
    announceView(bus, "todo.widget");
    const [late] = [...clock.pending.values()];
    batcher.dispose();
    batcher.dispose();
    expect(batcher.disposed).toBe(true);
    expect(clock.pending.size).toBe(0);
    // A timer whose clearTimeout came too late still does nothing.
    late!.callback();
    announceView(bus, "todo.widget");
    batcher.schedule();
    batcher.flushNow();
    clock.runAll();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("hands a failing flush to onError and keeps batching", () => {
    const bus = fakeEventBus();
    const clock = manualTimers();
    const onError = vi.fn();
    let calls = 0;
    batchViews(bus, {
      flush: () => {
        calls++;
        throw new Error("socket closed");
      },
      delayMs: 10,
      timers: clock.timers,
      onError,
    });
    announceView(bus, "todo.widget");
    clock.runAll();
    expect(calls).toBe(2);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenLastCalledWith(new Error("socket closed"));
    // Without onError the timer still survives a throwing flush.
    expect(() =>
      batchViews(bus, {
        flush: () => {
          throw new Error("x");
        },
        delayMs: 10,
        timers: clock.timers,
      }),
    ).not.toThrow();
  });

  it("uses the global timers by default", () => {
    vi.useFakeTimers();
    const bus = fakeEventBus();
    const flush = vi.fn();
    const batcher = batchViews(bus, { flush, delayMs: 100 });
    announceView(bus, "todo.widget");
    vi.advanceTimersByTime(99);
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(2);
    announceView(bus, "todo.widget");
    batcher.dispose();
    vi.advanceTimersByTime(1000);
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
