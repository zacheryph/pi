// Loaded as an extension by restore-sdk.test.ts: a child that hangs in `session_start` when its
// transcript is reopened, as an extension that never finishes starting up would. Only the first
// reopened session with the id the test names hangs, and only until the test releases it; a new
// session (reason `startup`) and every later session with that id start normally. `shutdowns`
// counts the hung session's own `session_shutdown`, which is how a test knows it was disposed.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const HANG = Symbol.for("pi-subagent.test.hang-on-reopen");

export interface Hang {
  /** The session id to hold. */
  sessionId: string;
  /** Settles when the held session may finish starting. */
  release: Promise<void>;
  /** A session took the hold already. */
  taken: boolean;
  /** How many times the held session was shut down. */
  shutdowns: number;
}

export default function hangOnReopen(pi: ExtensionAPI): void {
  let held = false;
  pi.on("session_start", async (event, ctx) => {
    const hang = (globalThis as Record<symbol, Hang | undefined>)[HANG];
    if (event.reason === "startup" || !hang || hang.taken) return;
    if (ctx.sessionManager.getSessionId() !== hang.sessionId) return;
    hang.taken = true;
    held = true;
    await hang.release;
  });
  pi.on("session_shutdown", () => {
    const hang = (globalThis as Record<symbol, Hang | undefined>)[HANG];
    if (held && hang) hang.shutdowns++;
  });
}
