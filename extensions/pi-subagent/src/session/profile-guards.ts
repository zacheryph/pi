/**
 * profile-guards.ts — Keep a profile's standing rules in force as a session grows.
 *
 * A system prompt sits at the start of the context. As a conversation grows,
 * the recent messages outweigh it, and a rule the profile states there, such
 * as orchestrate's "delegate, do not do the work", loses its hold. Two profile
 * fields hold such a rule in place:
 *
 * - `reminder` is restated on every request, while the `agentReminders`
 *   setting is on, right after the latest user
 *   message, where the model reads it together with the request it answers.
 *   It is a `custom` message with `display: false`, added in the `context`
 *   event: never written to the transcript or shown in the TUI. It keeps its
 *   position for the whole turn, so the turn's later requests still share the
 *   cached prefix.
 * - `reserved_tools` names tools the agent may not call itself. A call is
 *   refused with a reason that sends the work to a worker. The tools stay
 *   registered, so the workers the agent starts still inherit them.
 */

import type {
  ContextEvent,
  ExtensionFactory,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextEvent["messages"][number];

/** The `customType` the reminder is inserted under. */
export const AGENT_REMINDER_TYPE = "agent:reminder";

/**
 * The messages with `reminder` placed right after the latest user message, or
 * at the end when there is none. Earlier copies are removed first.
 */
export function withAgentReminder(
  messages: readonly AgentMessage[],
  reminder: string,
  now: number = Date.now(),
): AgentMessage[] {
  const kept = messages.filter(
    (message) => !(message.role === "custom" && message.customType === AGENT_REMINDER_TYPE),
  );
  const body = reminder.trim();
  if (!body) return kept;
  const card: AgentMessage = {
    role: "custom",
    customType: AGENT_REMINDER_TYPE,
    content: `<agent_reminder>\n${body}\n</agent_reminder>`,
    display: false,
    timestamp: now,
  };
  const lastUser = kept.findLastIndex((message) => message.role === "user");
  const at = lastUser < 0 ? kept.length : lastUser + 1;
  return [...kept.slice(0, at), card, ...kept.slice(at)];
}

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
      "Start a worker with subagent_start, or resume one, to do this work.",
  };
}

export interface ProfileGuards {
  name: string;
  reminder?: string;
  reservedTools?: readonly string[];
}

/** Whether the profile declares anything a guard enforces. */
export function hasProfileGuards(profile: ProfileGuards): boolean {
  return Boolean(profile.reminder?.trim()) || Boolean(profile.reservedTools?.length);
}

/**
 * A child-session extension enforcing the profile's reminder and reserved tools.
 * `remindersEnabled` is read on every request, so the setting applies at once.
 */
export function profileGuardsExtension(
  profile: ProfileGuards,
  remindersEnabled: () => boolean = () => true,
): ExtensionFactory {
  return (pi) => {
    const { name, reminder, reservedTools } = profile;
    if (reminder?.trim())
      pi.on("context", (event) =>
        remindersEnabled() ? { messages: withAgentReminder(event.messages, reminder) } : undefined,
      );
    if (reservedTools?.length)
      pi.on("tool_call", (event) => reservedToolRefusal(event, reservedTools, name));
  };
}
