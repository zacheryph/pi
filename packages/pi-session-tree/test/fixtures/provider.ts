// Loaded by Pi's real extension loader in sdk.test.ts; imports the library by relative path.
import { provide, sessionTree } from "../../src/index.ts";

export default function provider(): void {
  (globalThis as Record<symbol, unknown>)[Symbol.for("pi-session-tree.test.provider")] = sessionTree;
  provide("session-1", "probe", { hello: "from provider" });
}
