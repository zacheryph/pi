import { describe, expect, it } from "vitest";
import { registerRosterCard, ROSTER_CARD_TYPE } from "#src/handlers/roster-card";
import type { AgentMessage, CardResult } from "#session-state";
import { fakePi } from "#test-helpers";
import type { DisplayStatus, SubagentStatus } from "#src/lifecycle/subagent-state";
import { type PersistedSubagentRecord, SUBAGENT_RECORD_ENTRY } from "#src/persisted-record";
import type { LiveAgentLike } from "#src/roster";
import { stateForLabel } from "#test/helpers/make-subagent";

/** A saved record; `status` also takes today's display labels (see `stateForLabel`). */
function saved(
  overrides: Omit<Partial<PersistedSubagentRecord>, "status"> & {
    status?: SubagentStatus | DisplayStatus;
  } = {},
): PersistedSubagentRecord {
  const { status = "completed", ...rest } = overrides;
  return {
    version: 2,
    id: "a1",
    type: "implementer",
    description: "Add token refresh",
    ...(status === "idle" ? { status, outcome: "completed" as const } : stateForLabel(status)),
    result: "done",
    error: undefined,
    turnBudget: undefined,
    startedAt: 1_000,
    completedAt: 2_000,
    outputFile: undefined,
    toolUses: 0,
    ...rest,
  } as PersistedSubagentRecord;
}

/** A context whose branch holds these records; mutable so a test can add more. */
function branchCtx(records: PersistedSubagentRecord[]) {
  return {
    sessionManager: {
      getBranch: () =>
        records.map((data) => ({ type: "custom", customType: SUBAGENT_RECORD_ENTRY, data })),
    },
  };
}

const user = (text: string, timestamp = 0) => ({
  role: "user" as const,
  content: text,
  timestamp,
});

const listResult = (timestamp: number, overrides: Record<string, unknown> = {}) => ({
  role: "toolResult" as const,
  toolCallId: "call",
  toolName: "subagent_get",
  content: [{ type: "text" as const, text: "Agents started on this branch" }],
  details: { kind: "list", total: 1 },
  isError: false,
  timestamp,
  ...overrides,
});

const staleCard = {
  role: "custom" as const,
  customType: ROSTER_CARD_TYPE,
  content: "old card",
  display: false,
  timestamp: 0,
};

function setup(records: PersistedSubagentRecord[], live?: (id: string) => LiveAgentLike) {
  let clock = 100;
  const fake = fakePi();
  registerRosterCard(fake.api, { getLive: (id) => live?.(id), now: () => clock });
  const ctx = branchCtx(records);
  /** Run every handler for `event` now; the card's handlers are all synchronous. */
  const fire = (event: string, payload: object = {}): unknown => {
    let result: unknown;
    for (const handler of fake.handlers.get(event) ?? [])
      result = handler({ type: event, ...payload }, ctx);
    return result;
  };
  const context = (messages: unknown[]) =>
    fire("context", { messages: messages as AgentMessage[] }) as CardResult;
  return {
    fire,
    context,
    tick: (to: number) => {
      clock = to;
    },
  };
}

const cardText = (result: CardResult) => {
  const last = result?.messages.at(-1);
  return last?.role === "custom" && last.customType === ROSTER_CARD_TYPE ? last.content : undefined;
};

describe("registerRosterCard", () => {
  it("is off until a session event brings it back", () => {
    const { context } = setup([saved()]);
    expect(context([user("hi")])).toBeUndefined();
  });

  it.each([
    ["compaction", (h: ReturnType<typeof setup>) => h.fire("session_compact")],
    ["reload", (h: ReturnType<typeof setup>) => h.fire("session_start", { reason: "reload" })],
    ["resume", (h: ReturnType<typeof setup>) => h.fire("session_start", { reason: "resume" })],
    ["/tree", (h: ReturnType<typeof setup>) => h.fire("session_tree")],
  ])("is appended after %s as a hidden custom message", (reason, trigger) => {
    const h = setup([saved({ id: "x1" })]);
    trigger(h);
    const result = h.context([user("hi")]);
    expect(result?.messages).toHaveLength(2);
    expect(result?.messages.at(-1)).toMatchObject({
      role: "custom",
      customType: ROSTER_CARD_TYPE,
      display: false,
    });
    expect(cardText(result)).toContain(`(restored after ${reason};`);
    expect(cardText(result)).toContain(
      '- x1 implementer "Add token refresh": idle, last run completed',
    );
  });

  it("is sent once per request: an earlier card is replaced, not repeated", () => {
    const h = setup([saved()]);
    h.fire("session_compact");
    const result = h.context([user("hi"), staleCard, user("again")]);
    const cards = result!.messages.filter(
      (message) => message.role === "custom" && message.customType === ROSTER_CARD_TYPE,
    );
    expect(cards).toHaveLength(1);
    expect(cardText(result)).not.toBe("old card");
  });

  it("keeps arriving on every request until the model lists the agents", () => {
    const h = setup([saved()]);
    h.fire("session_compact");
    expect(cardText(h.context([user("one")]))).toBeDefined();
    expect(cardText(h.context([user("one"), user("two")]))).toBeDefined();
  });

  it("stops once a subagent_get list result arrives after the event", () => {
    const h = setup([saved()]);
    h.fire("session_compact");
    h.tick(200);
    expect(h.context([user("hi"), listResult(150)])).toBeUndefined();
    // Stays off on later requests, even once the list result scrolls away.
    expect(h.context([user("later")])).toBeUndefined();
  });

  it("strips a stale card even when the stop rule ends it", () => {
    const h = setup([saved()]);
    h.fire("session_compact");
    const result = h.context([staleCard, user("hi"), listResult(150)]);
    expect(result?.messages).toHaveLength(2);
    expect(cardText(result)).toBeUndefined();
  });

  it.each([
    ["from before the event", listResult(50)],
    ["that failed", listResult(150, { isError: true })],
    ["for one agent", listResult(150, { details: { agentId: "a1" } })],
    ["from another tool", listResult(150, { toolName: "stash_list" })],
  ])("ignores a result %s", (_label, result) => {
    const h = setup([saved()]);
    h.fire("session_compact");
    expect(cardText(h.context([user("hi"), result]))).toBeDefined();
  });

  it("comes back after a later reload or /tree, though the list result is still in context", () => {
    const h = setup([saved()]);
    h.fire("session_compact");
    const messages = [user("hi"), listResult(150)];
    expect(h.context(messages)).toBeUndefined();
    h.tick(300);
    h.fire("session_tree");
    expect(cardText(h.context(messages))).toContain("restored after /tree");
    h.tick(400);
    h.fire("session_start", { reason: "reload" });
    expect(cardText(h.context(messages))).toContain("restored after reload");
  });

  it("shows no card for a branch that started no agents", () => {
    const h = setup([]);
    h.fire("session_start", { reason: "resume" });
    expect(h.context([user("hi")])).toBeUndefined();
  });

  it("does not arm for a fresh session that spawns its first agent later", () => {
    const records: PersistedSubagentRecord[] = [];
    const h = setup(records);
    h.fire("session_start", { reason: "startup" });
    records.push(saved());
    expect(h.context([user("hi")])).toBeUndefined();
  });

  it("turns off after /tree to a branch with no agents", () => {
    const records = [saved()];
    const h = setup(records);
    h.fire("session_compact");
    records.length = 0;
    h.fire("session_tree");
    records.push(saved());
    expect(h.context([user("hi")])).toBeUndefined();
  });

  it("rebuilds the card from live state on each request", () => {
    const record = saved({ status: "running", completedAt: undefined });
    let live: LiveAgentLike = record;
    const h = setup([record], () => live);
    h.fire("session_compact");
    expect(cardText(h.context([user("hi")]))).toContain(": running");
    live = { ...record, status: "idle", outcome: "completed", completedAt: 5_000 };
    expect(cardText(h.context([user("hi")]))).toContain(": idle, last run completed ");
  });

  it("turns off at shutdown", () => {
    const h = setup([saved()]);
    h.fire("session_compact");
    h.fire("session_shutdown");
    expect(h.context([user("hi")])).toBeUndefined();
  });
});
