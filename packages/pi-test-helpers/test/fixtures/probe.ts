import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Fixture only: proves Pi's loader ran this file. */
export default function probe(_pi: ExtensionAPI): void {
  (globalThis as Record<symbol, unknown>)[Symbol.for("pi-test-helpers.test.loaded")] = true;
}
