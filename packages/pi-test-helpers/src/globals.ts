import { SESSION_TREE_KEY } from "#session-tree";

/** `globalThis` as a store of Symbol-keyed slots, as fixtures and the session tree use it. */
export const slots = globalThis as Record<symbol, unknown>;

/** Remove Symbol-keyed slots from `globalThis`. */
export function clearSlots(...keys: symbol[]): void {
  // oxlint-disable-next-line typescript/no-dynamic-delete -- Symbol-keyed globals in tests.
  for (const key of keys) delete slots[key];
}

/**
 * Forget every session, link and service registered with pi-session-tree, so
 * the next test starts with an empty process-wide registry.
 */
export function resetSessionTree(): void {
  clearSlots(SESSION_TREE_KEY);
}

/** Set a Symbol-keyed slot for the duration of `run`, then remove it. */
export function withSlot<T>(key: symbol, value: unknown, run: () => T): T {
  slots[key] = value;
  let async = false;
  try {
    const result = run();
    if (result instanceof Promise) {
      async = true;
      return result.finally(() => clearSlots(key)) as T;
    }
    return result;
  } finally {
    if (!async) clearSlots(key);
  }
}
