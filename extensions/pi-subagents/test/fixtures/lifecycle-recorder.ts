// Loaded as an extension by handoff-sdk.test.ts: records the child lifecycle
// payloads pi-subagents emits on this session's bus.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const LIFECYCLE_LOG = Symbol.for("pi-subagents.test.lifecycle-log");
const CHANNELS = [
  "subagents:child:session-created",
  "subagents:child:bound",
  "subagents:child:disposed",
];

export default function lifecycleRecorder(pi: ExtensionAPI): void {
  const slots = globalThis as Record<symbol, unknown>;
  const log = (slots[LIFECYCLE_LOG] ??= []) as Array<{ channel: string; data: unknown }>;
  for (const channel of CHANNELS)
    pi.events.on(channel, (data) => {
      log.push({ channel, data });
    });
}
