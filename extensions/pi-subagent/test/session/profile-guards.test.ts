import { describe, expect, it } from "vitest";
import {
  AGENT_REMINDER_TYPE,
  hasProfileGuards,
  profileGuardsExtension,
  reservedToolRefusal,
  withAgentReminder,
} from "#src/session/profile-guards";

type Messages = Parameters<typeof withAgentReminder>[0];

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 });
const assistant = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 }) as unknown;
const reminderAt = (messages: readonly { role: string; customType?: string }[]) =>
  messages.flatMap((m, i) =>
    m.role === "custom" && m.customType === AGENT_REMINDER_TYPE ? [i] : [],
  );

/** Load the guards extension into a stub and return its handlers by event. */
function load(guards: Parameters<typeof profileGuardsExtension>[0]) {
  const handlers = new Map<string, Function>();
  void profileGuardsExtension(guards)({
    on: (name: string, fn: Function) => handlers.set(name, fn),
  } as never);
  return handlers;
}

describe("withAgentReminder", () => {
  it("places the reminder right after the latest user message, wrapped and hidden", () => {
    const messages = [user("one"), assistant("a"), user("two"), assistant("b")] as Messages;
    const out = withAgentReminder(messages, "  Delegate.  ", 7);
    expect(reminderAt(out)).toEqual([3]);
    expect(out[3]).toEqual({
      role: "custom",
      customType: AGENT_REMINDER_TYPE,
      content: "<agent_reminder>\nDelegate.\n</agent_reminder>",
      display: false,
      timestamp: 7,
    });
    expect(out.filter((m) => m.role !== "custom")).toEqual(messages);
  });

  it("keeps exactly one copy, moved to follow the newest user message", () => {
    const first = withAgentReminder([user("one"), assistant("a")] as Messages, "R");
    const next = withAgentReminder([...first, user("two")] as Messages, "R");
    expect(reminderAt(next)).toEqual([3]);
  });

  it("appends at the end when there is no user message yet", () => {
    expect(reminderAt(withAgentReminder([assistant("a")] as Messages, "R"))).toEqual([1]);
  });

  it("only removes earlier copies for a blank reminder", () => {
    const first = withAgentReminder([user("one")] as Messages, "R");
    expect(withAgentReminder(first, "   ")).toEqual([user("one")]);
  });
});

describe("reservedToolRefusal", () => {
  it("blocks a reserved tool with a reason that sends the work to a worker", () => {
    expect(reservedToolRefusal({ toolName: "bash" }, ["edit", "bash"], "orchestrate")).toEqual({
      block: true,
      reason:
        "bash is reserved for workers: as orchestrate you coordinate and delegate. " +
        "Start a worker with subagent_start, or resume one, to do this work.",
    });
  });

  it("lets every other tool through", () => {
    expect(reservedToolRefusal({ toolName: "read" }, ["edit", "bash"], "orchestrate")).toBe(
      undefined,
    );
  });
});

describe("profileGuardsExtension", () => {
  it("restates the reminder and refuses reserved tools", () => {
    const handlers = load({ name: "orchestrate", reminder: "R", reservedTools: ["write"] });
    expect(reminderAt(handlers.get("context")?.({ messages: [user("hi")] }).messages)).toEqual([1]);
    expect(handlers.get("tool_call")?.({ toolName: "write" })).toMatchObject({ block: true });
    expect(handlers.get("tool_call")?.({ toolName: "read" })).toBeUndefined();
  });

  it("registers only the guards the profile declares", () => {
    expect([...load({ name: "a", reminder: "R" }).keys()]).toEqual(["context"]);
    expect([...load({ name: "a", reservedTools: ["write"] }).keys()]).toEqual(["tool_call"]);
    expect(hasProfileGuards({ name: "a", reminder: "  ", reservedTools: [] })).toBe(false);
  });
});
