// Project-local Pi extension for working on this repository: blocks shell
// commands that run a formatter or linter the repository does not use
// (Prettier, ESLint, Biome, dprint) and tells the agent to use oxfmt and
// oxlint. The check lives in scripts/tool-guard.mjs, shared with the Claude
// Code hook in .claude/settings.json. Not part of the bundle.

import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { foreignToolProblem } from "../../scripts/tool-guard.mjs";

export default function toolGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    const reason = foreignToolProblem(event.input.command);
    return reason ? { block: true, reason } : undefined;
  });
}
