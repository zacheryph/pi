/** Teardown a helper registers for what it created. */
export type Cleanup = () => void | Promise<void>;

/**
 * Where a helper registers its teardown. Pass vitest's `onTestFinished`
 * (works in tests, helpers and `beforeEach`), or a node:test context (`t`),
 * whose `after` runs once the test ends.
 */
export type Defer = ((cleanup: Cleanup) => void) | { after(cleanup: Cleanup): void };

export function defer(target: Defer, cleanup: Cleanup): void {
  if (typeof target === "function") target(cleanup);
  else target.after(cleanup);
}
