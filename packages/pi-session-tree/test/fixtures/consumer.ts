// Loaded after provider.ts by Pi's real extension loader in sdk.test.ts.
import { service, sessionTree } from "../../src/index.ts";

export default function consumer(): void {
  const slots = globalThis as Record<symbol, unknown>;
  slots[Symbol.for("pi-session-tree.test.consumer")] = sessionTree;
  slots[Symbol.for("pi-session-tree.test.seen")] = service("session-1", "probe");
}
