import { describe, expect, it } from "vitest";
import { registerRosterCard, ROSTER_CARD_TYPE } from "#src/handlers/roster-card";
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

/** A branch holding these records after a compaction; mutable so a test can change it. */
function branchCtx(records: PersistedSubagentRecord[], compacted = true) {
  const extra: object[] = compacted ? [{ type: "compaction" }] : [];
  return {
    extra,
    ctx: {
      sessionManager: {
        getBranch: () => [
          ...records.map((data) => ({ type: "custom", customType: SUBAGENT_RECORD_ENTRY, data })),
          ...extra,
        ],
      },
    },
  };
}

function setup(
  records: PersistedSubagentRecord[],
  { live, compacted }: { live?: (id: string) => LiveAgentLike; compacted?: boolean } = {},
) {
  const fake = fakePi();
  registerRosterCard(fake.api, { getLive: (id) => live?.(id) });
  const branch = branchCtx(records, compacted);
  // Pi appends the card to the branch, where a later event finds it.
  fake.pi.sendMessage.mockImplementation((message: { customType: string }) =>
    branch.extra.push({ type: "custom_message", customType: message.customType }),
  );
  return {
    fake,
    extra: branch.extra,
    fire: (event: string, payload: object = {}) => fake.emit(event, payload, branch.ctx),
    /** The text of every card written so far. */
    cards: () =>
      fake.pi.sendMessage.mock.calls.map(([message, options]) => {
        expect(message).toMatchObject({ customType: ROSTER_CARD_TYPE, display: false });
        expect(options).toEqual({ triggerTurn: false });
        return (message as { content: string }).content;
      }),
  };
}

describe("registerRosterCard", () => {
  it("writes one hidden card after a compaction on a branch with agents", async () => {
    const h = setup([saved({ id: "x1" })]);
    await h.fire("session_compact");
    expect(h.cards()).toEqual([expect.stringContaining("(restored after compaction;")]);
    expect(h.cards()[0]).toContain(
      '- x1 implementer "Add token refresh": idle, last run completed',
    );
  });

  it.each([
    ["reload", "session_start", { reason: "reload" }],
    ["resume", "session_start", { reason: "resume" }],
    ["/tree", "session_tree", {}],
  ])(
    "writes nothing more after a %s once the card is on the branch",
    async (_n, event, payload) => {
      const h = setup([saved()]);
      await h.fire("session_compact");
      await h.fire(event, payload);
      expect(h.cards()).toHaveLength(1);
    },
  );

  it("writes a card on resume when a compaction on the branch has none", async () => {
    const h = setup([saved()]);
    await h.fire("session_start", { reason: "resume" });
    expect(h.cards()).toHaveLength(1);
  });

  it.each([
    ["resume", "session_start", { reason: "resume" }],
    ["/tree", "session_tree", {}],
  ])("writes nothing after a %s without a compaction", async (_n, event, payload) => {
    const h = setup([saved()], { compacted: false });
    await h.fire(event, payload);
    expect(h.cards()).toEqual([]);
  });

  it("writes nothing for a branch that started no agents", async () => {
    const h = setup([]);
    await h.fire("session_compact");
    expect(h.cards()).toEqual([]);
  });

  it("builds the card from live state", async () => {
    const record = saved({ status: "running", completedAt: undefined });
    const h = setup([record], { live: () => record });
    await h.fire("session_compact");
    expect(h.cards()[0]).toContain(": running");
  });
});
