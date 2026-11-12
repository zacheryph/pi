/**
 * reserved-tools.ts — Refuse an agent's own calls to the tools its profile reserves.
 *
 * `reserved_tools` names tools a coordinating agent may not call itself. A call
 * is refused with a reason that sends the work to a worker. The tools stay
 * registered, so the workers the agent starts still inherit them; a `-name`
 * exclusion in `tools` would take them from those workers as well.
 */

import type {
  ExtensionFactory,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

/** The refusal for a call to a reserved tool, or undefined when the tool is not reserved. */
export function reservedToolRefusal(
  event: Pick<ToolCallEvent, "toolName">,
  reservedTools: readonly string[],
  agentName: string,
): ToolCallEventResult | undefined {
  if (!reservedTools.includes(event.toolName)) return undefined;
  return {
    block: true,
    reason:
      `${event.toolName} is reserved for workers: as ${agentName} you coordinate and delegate. ` +
      "Start a worker with subagent_start, or message one with subagent_send, to do this work.",
  };
}

/** A child-session extension refusing the agent's own calls to its reserved tools. */
export function reservedToolsExtension(
  agentName: string,
  reservedTools: readonly string[],
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", (event) => reservedToolRefusal(event, reservedTools, agentName));
  };
}
