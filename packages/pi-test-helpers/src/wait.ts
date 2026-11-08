export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** One turn of the event loop: pending I/O callbacks and timers due now run first. */
export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Let chained promise callbacks settle without yielding to timers or I/O. */
export async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

export interface WaitOptions {
  /** Give up after this many milliseconds. Default 5000. */
  timeout?: number;
  /** Milliseconds between checks. Default 10. */
  interval?: number;
  /** What is awaited, for the timeout error. */
  what?: string;
}

/**
 * Poll `check` until it returns a truthy value, and return that value. For
 * real time only: under fake timers use `vi.waitFor` or advance the clock.
 */
export async function waitFor<T>(
  check: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  options: WaitOptions | number = {},
): Promise<T> {
  const {
    timeout = 5000,
    interval = 10,
    what = "condition",
  } = typeof options === "number" ? { timeout: options } : options;
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
    await sleep(interval);
  }
}
