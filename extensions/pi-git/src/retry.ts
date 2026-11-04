/**
 * retry.ts — bounded retry for transient GitHub failures.
 *
 * Copied from `@gotgenes/pi-github-tools` 6.1.0, `src/lib/retry.ts`
 * (https://github.com/gotgenes/pi-packages/tree/main/packages/pi-github-tools),
 * with its `sleep` inlined, the progress notice dropped, and cancellation
 * checked before each attempt. Reads only: a mutation is never retried.
 *
 * MIT License
 *
 * Copyright (c) 2026 Christopher D. Lasher
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/** Context handed to `onRetry` before each backoff sleep. */
export interface RetryAttempt {
  /** 1-indexed number of the attempt that just failed. */
  attempt: number;
  /** How long the caller is about to wait before the next attempt. */
  delayMs: number;
  error: Error;
}

export interface RetryOptions {
  onRetry?: (info: RetryAttempt) => void;
  signal?: AbortSignal;
  /** Replaces the backoff sleep; for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Failures worth retrying: a server-side 5xx, GitHub's GraphQL unavailability
 * message, and the transport errors the `gh` binary passes through from Go's
 * HTTP client. A 4xx (including rate limiting) is deliberately absent —
 * retrying it is either useless or harmful.
 */
const TRANSIENT_PATTERNS = [
  /HTTP 5\d\d/,
  /no server is currently available/i,
  /connection reset/i,
  /\bEOF\b/,
  /i\/o timeout/i,
  /TLS handshake timeout/i,
  /dial tcp/i,
];

/** True when a GitHub read failure is worth retrying. */
export function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(error.message));
}

/** Backoff before retry `attempt` (1-indexed), in milliseconds: 1 s, 4 s, 9 s. */
export function transientRetryDelay(attempt: number): number {
  return BASE_DELAY_MS * attempt ** 2;
}

/**
 * Run `fn`, retrying transient failures up to three times. A permanent
 * failure, an abort during the backoff, and the final attempt's error all
 * propagate unchanged.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const wait = options.sleep ?? sleep;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await fn();
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!isTransientError(error)) throw error;
      const delayMs = transientRetryDelay(attempt);
      options.onRetry?.({ attempt, delayMs, error: asError(error) });
      await wait(delayMs, options.signal);
    }
  }
  options.signal?.throwIfAborted();
  return fn();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
