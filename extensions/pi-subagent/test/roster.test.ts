import { describe, expect, it, vi } from "vitest";
import type { DisplayStatus, RunOutcome, SubagentStatus } from "#src/lifecycle/subagent-state";
import type { PersistedSubagentRecord } from "#src/persisted-record";
import {
  buildRoster,
  CARD_MAX_LINES,
  clipText,
  formatClock,
  formatRosterCard,
  formatRosterLine,
  formatRosterList,
  type LiveAgentLike,
  readBranchRecords,
  rosterState,
} from "#src/roster";
import { stateForLabel } from "#test/helpers/make-subagent";

/**
 * A saved record. `status` also takes one of today's display labels
 * (`error`, `aborted`, `stopped`, `completed`), standing for the status and
 * outcome that read that way.
 */
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

const noneLive = () => undefined;

describe("rosterState", () => {
  it.each<[SubagentStatus, RunOutcome | undefined, string | undefined, boolean, string]>([
    ["idle", "completed", undefined, true, "completed"],
    ["idle", "completed", "Which DB?", false, "waiting"],
    ["running", undefined, undefined, true, "running"],
    ["queued", undefined, undefined, true, "queued"],
    ["running", undefined, undefined, false, "interrupted"],
    ["queued", undefined, undefined, false, "interrupted"],
    ["idle", "error", undefined, false, "error"],
    ["idle", "turn-limit", "Which DB?", false, "aborted"],
    ["idle", "stopped", undefined, true, "stopped"],
    ["idle", "stopped", "Which DB?", true, "stopped"],
    // A run a reload or restart cut short, as a version 1 record reads back.
    ["idle", "interrupted", undefined, false, "interrupted"],
  ])("%s after %s, question %s, live %s → %s", (status, outcome, question, live, expected) => {
    expect(rosterState(status, outcome, question, live)).toBe(expected);
  });
});

describe("buildRoster", () => {
  it("orders waiting, running, failed, then completed newest first", () => {
    const records = [
      saved({ id: "done-old", completedAt: 10 }),
      saved({ id: "failed", status: "error", error: "boom", startedAt: 5 }),
      saved({ id: "done-new", completedAt: 30 }),
      saved({ id: "running", status: "running", completedAt: undefined }),
      saved({ id: "waiting", pendingQuestion: "Which DB?" }),
      saved({ id: "stopped", status: "stopped", startedAt: 6 }),
    ];
    const live = (id: string) =>
      id === "running" ? ({ ...records[3], status: "running" } as LiveAgentLike) : undefined;
    expect(buildRoster(records, live).map((entry) => entry.id)).toEqual([
      "waiting",
      "running",
      "stopped",
      "failed",
      "done-new",
      "done-old",
    ]);
  });

  it("takes live state over the saved record", () => {
    const record = saved({ status: "running", completedAt: undefined });
    const live: LiveAgentLike = {
      ...record,
      status: "idle",
      outcome: "completed",
      completedAt: 9_000,
    };
    const [entry] = buildRoster([record], () => live);
    expect(entry).toMatchObject({ state: "completed", completedAt: 9_000, live: true });
  });

  it("calls a running record with no live agent interrupted", () => {
    const [entry] = buildRoster([saved({ status: "running" })], noneLive);
    expect(entry).toMatchObject({ state: "interrupted", live: false });
  });
});

describe("clipText", () => {
  it("keeps text within the limit unchanged", () => {
    expect(clipText("short", 80)).toBe("short");
  });

  it("cuts at the limit with an ellipsis", () => {
    const cut = clipText("x".repeat(100), 80);
    expect(Array.from(cut)).toHaveLength(80);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("strips ANSI codes before counting", () => {
    const styled = `\x1b[31m${"r".repeat(79)}\x1b[0m`;
    expect(clipText(styled, 80)).toBe("r".repeat(79));
    expect(clipText(`\x1b[1m${"b".repeat(90)}\x1b[0m`, 80)).toBe(`${"b".repeat(79)}…`);
  });

  it("keeps wide CJK characters whole", () => {
    expect(clipText("漢字".repeat(50), 5)).toBe("漢字漢字…");
  });

  it("keeps emoji clusters whole, including ZWJ sequences and flags", () => {
    const family = "👨‍👩‍👧";
    expect(clipText(`${family}${family}${family}`, 3)).toBe(`${family}${family}${family}`);
    expect(clipText(`${family}${family}${family}`, 2)).toBe(`${family}…`);
    expect(clipText("🇯🇵🇫🇷🇩🇪", 2)).toBe("🇯🇵…");
  });

  it("folds newlines and runs of whitespace into single spaces", () => {
    expect(clipText("one\n two\t\tthree", 80)).toBe("one two three");
  });
});

describe("formatRosterLine", () => {
  const line = (record: PersistedSubagentRecord, live?: LiveAgentLike) =>
    formatRosterLine(buildRoster([record], () => live)[0]);

  it("quotes the question an agent is waiting on", () => {
    expect(line(saved({ id: "9a8b7c", pendingQuestion: "Postgres or SQLite?" }))).toBe(
      '- 9a8b7c implementer "Add token refresh": waiting for your answer: "Postgres or SQLite?"',
    );
  });

  it("labels a running agent", () => {
    const record = saved({ id: "d4e5f6", type: "review", status: "running" });
    expect(line(record, record)).toBe('- d4e5f6 review "Add token refresh": running');
  });

  it("gives a completed agent its local finish time", () => {
    expect(line(saved({ completedAt: 7_200_000 }))).toBe(
      `- a1 implementer "Add token refresh": idle, last run completed ${formatClock(7_200_000)}`,
    );
  });

  it("names the error, the exhausted budget, a stop and an interruption", () => {
    expect(line(saved({ status: "error", error: "boom\nstack" }))).toContain(
      "idle, last run failed: boom stack",
    );
    expect(line(saved({ status: "aborted" }))).toContain(
      "idle, last run failed: turn budget exhausted",
    );
    expect(line(saved({ status: "stopped" }))).toContain(
      "idle, last run stopped before it finished",
    );
    expect(line(saved({ status: "running" }))).toContain(
      "idle, last run interrupted: the session was reloaded or replaced before it finished",
    );
    // The same line for a run a version 1 record said was cut short.
    expect(line(saved({ status: "idle", outcome: "interrupted" }))).toContain(
      "idle, last run interrupted: the session was reloaded or replaced before it finished",
    );
  });

  it("cuts descriptions to 80 characters and questions to 160", () => {
    const text = line(saved({ description: "d".repeat(200), pendingQuestion: "q".repeat(300) }));
    expect(text).toContain(`"${"d".repeat(79)}…"`);
    expect(text).toContain(`"${"q".repeat(159)}…"`);
    expect(text).not.toContain("d".repeat(80));
  });

  it("strips terminal controls from saved text", () => {
    const text = line(saved({ description: "\x1b[2Jwipe\x1b]0;title\x07 me" }));
    expect(text).toContain('"wipe me"');
    // oxlint-disable-next-line no-control-regex -- asserting no escape survives
    expect(text).not.toMatch(/\x1b/);
  });
});

describe("formatRosterCard", () => {
  it("is absent for a branch that started no agents", () => {
    expect(formatRosterCard([], "compaction")).toBeUndefined();
  });

  it("matches the documented layout for a mix of states", () => {
    const records = [
      saved({ id: "a1b2c3", completedAt: 50_000_000 }),
      saved({
        id: "77e0aa",
        type: "explorer",
        description: "Map auth call sites",
        status: "aborted",
        startedAt: 3_000,
      }),
      saved({ id: "d4e5f6", type: "review", description: "Review step 3", status: "running" }),
      saved({ id: "9a8b7c", description: "Migrate store", pendingQuestion: "Postgres?" }),
    ];
    const live = (id: string) => (id === "d4e5f6" ? records[2] : undefined);
    expect(formatRosterCard(buildRoster(records, live), "compaction")).toBe(
      [
        "Subagents started by this session (restored after compaction; subagent_get <id> for details, subagent_send <id> to give an idle one more work):",
        '- 9a8b7c implementer "Migrate store": waiting for your answer: "Postgres?"',
        '- d4e5f6 review "Review step 3": running',
        '- 77e0aa explorer "Map auth call sites": idle, last run failed: turn budget exhausted',
        `- a1b2c3 implementer "Add token refresh": idle, last run completed ${formatClock(50_000_000)}`,
      ].join("\n"),
    );
  });

  it("names the event that brought it back", () => {
    expect(formatRosterCard(buildRoster([saved()], noneLive), "/tree")).toMatch(
      /^Subagents started by this session \(restored after \/tree;/,
    );
  });

  describe(`the ${CARD_MAX_LINES}-line cap`, () => {
    const completed = (count: number, from = 0) =>
      Array.from({ length: count }, (_, index) =>
        saved({ id: `done-${from + index}`, completedAt: 10_000 + from + index }),
      );
    const bodyLines = (card: string | undefined) => card!.split("\n").slice(1);

    it("shows exactly twenty agents without an overflow line", () => {
      const lines = bodyLines(formatRosterCard(buildRoster(completed(20), noneLive), "reload"));
      expect(lines).toHaveLength(20);
      expect(lines.at(-1)).not.toContain("not shown");
    });

    it("keeps nineteen whole lines and counts the oldest completed agents left out", () => {
      const lines = bodyLines(formatRosterCard(buildRoster(completed(21), noneLive), "reload"));
      expect(lines).toHaveLength(20);
      expect(lines[0]).toContain("done-20");
      expect(lines[18]).toContain("done-2");
      expect(lines.at(-1)).toBe("- 2 older completed agents not shown");
    });

    it("uses the singular for one agent left out", () => {
      // The overflow line takes a slot of its own, so only pinned agents filling
      // the card leave a single agent out.
      const waiting = Array.from({ length: 20 }, (_, index) =>
        saved({ id: `w-${index}`, pendingQuestion: "?" }),
      );
      const lines = bodyLines(
        formatRosterCard(buildRoster([...waiting, ...completed(1)], noneLive), "reload"),
      );
      expect(lines).toHaveLength(21);
      expect(lines.at(-1)).toBe("- 1 older completed agent not shown");
    });

    it("counts failed agents separately from completed ones", () => {
      const waiting = Array.from({ length: 18 }, (_, index) =>
        saved({ id: `w-${index}`, pendingQuestion: "?" }),
      );
      const failed = [
        saved({ id: "f1", status: "error", error: "x" }),
        saved({ id: "f2", status: "error", error: "y" }),
      ];
      const lines = bodyLines(
        formatRosterCard(buildRoster([...waiting, ...failed, ...completed(3)], noneLive), "reload"),
      );
      expect(lines).toHaveLength(20);
      expect(lines.slice(0, 18).every((text) => text.includes("waiting"))).toBe(true);
      expect(lines[18]).toContain("last run failed: ");
      expect(lines.at(-1)).toBe("- 1 failed and 3 older completed agents not shown");
    });

    it("never drops a waiting or running agent, even past the cap", () => {
      const running = Array.from({ length: 22 }, (_, index) =>
        saved({ id: `r-${index}`, status: "running", startedAt: index }),
      );
      const records = [...running, ...completed(2)];
      const live = (id: string) => records.find((record) => record.id === id && id.startsWith("r"));
      const lines = bodyLines(formatRosterCard(buildRoster(records, live), "reload"));
      expect(lines.filter((text) => text.endsWith(": running"))).toHaveLength(22);
      expect(lines.at(-1)).toBe("- 2 older completed agents not shown");
    });
  });
});

describe("formatRosterList", () => {
  it("says when the branch started no agents", () => {
    expect(formatRosterList([])).toBe("No agents were started on this branch of the session.");
  });

  it("lists every agent with a count", () => {
    const text = formatRosterList(buildRoster([saved({ id: "x" }), saved({ id: "y" })], noneLive));
    expect(text.split("\n")[0]).toBe(
      "Agents started on this branch (2; subagent_get <id> for details, subagent_send <id> to give an idle one more work):",
    );
    expect(text).toContain("- x implementer");
    expect(text).toContain("- y implementer");
  });
});

describe("readBranchRecords", () => {
  it("is undefined without a session to read", () => {
    expect(readBranchRecords(undefined)).toBeUndefined();
    expect(readBranchRecords({})).toBeUndefined();
  });

  it("folds the current branch's records", () => {
    const ctx = {
      sessionManager: {
        getBranch: () => [
          { type: "custom", customType: "subagent:record", data: saved({ status: "running" }) },
          { type: "custom", customType: "subagent:record", data: saved() },
        ],
      },
    };
    expect(readBranchRecords(ctx)).toStrictEqual([saved()]);
  });
});

describe("buildRoster — whether subagent_send reaches an agent", () => {
  const line = (record: PersistedSubagentRecord, reachable: boolean) =>
    formatRosterLine(
      buildRoster(
        [record],
        () => undefined,
        () => reachable,
      )[0],
    );

  it("says nothing on a line the tool reaches, whatever the last outcome", () => {
    for (const status of ["completed", "error", "aborted", "stopped", "running"] as const) {
      expect(line(saved({ status, error: "boom" }), true)).not.toContain("cannot take a message");
    }
    expect(line(saved(), true)).toMatch(/: idle, last run completed \d\d:\d\d$/);
  });

  // Changed by roadmap step 7b (was: only completed, interrupted and waiting lines said
  // "resumable", and failed or stopped ones said nothing). Every idle agent takes a message,
  // so every idle line says when one would be refused.
  it("warns on every idle line the tool would refuse", () => {
    expect(line(saved(), false)).toMatch(
      /: idle, last run completed \d\d:\d\d \(cannot take a message\)$/,
    );
    expect(line(saved({ status: "error", error: "boom" }), false)).toMatch(
      /: idle, last run failed: boom \(cannot take a message\)$/,
    );
    expect(line(saved({ status: "aborted" }), false)).toMatch(
      /: idle, last run failed: turn budget exhausted \(cannot take a message\)$/,
    );
    expect(line(saved({ status: "stopped" }), false)).toMatch(
      /: idle, last run stopped before it finished \(cannot take a message\)$/,
    );
    const interrupted = saved({ status: "running", completedAt: undefined });
    expect(line(interrupted, false)).toMatch(/before it finished \(cannot take a message\)$/);
  });

  it("warns only when a question cannot be answered", () => {
    const waiting = saved({ pendingQuestion: "Which DB?" });
    expect(line(waiting, true)).toMatch(/"Which DB\?"$/);
    expect(line(waiting, false)).toMatch(/"Which DB\?" \(cannot take a message\)$/);
  });

  it("does not ask about a queued or running agent, which always takes a message", () => {
    const check = vi.fn(() => true);
    const live = (record: PersistedSubagentRecord) => record as unknown as LiveAgentLike;
    const running = saved({ id: "r", status: "running", completedAt: undefined });
    const queued = saved({ id: "q", status: "queued", completedAt: undefined });
    const entries = buildRoster(
      [running, queued],
      (id) => live(id === "r" ? running : queued),
      check,
    );
    expect(check).not.toHaveBeenCalled();
    expect(entries.map((entry) => entry.reachable)).toEqual([undefined, undefined]);
  });

  it("asks about the live agent when one backs the record", () => {
    const check = vi.fn(() => true);
    const live: LiveAgentLike = { ...saved(), outputFile: "/live.jsonl" };
    buildRoster([saved()], () => live, check);
    expect(check).toHaveBeenCalledWith(live);
  });
});

describe("idle roster lines at hostile widths of text", () => {
  const line = (record: PersistedSubagentRecord) =>
    formatRosterLine(buildRoster([record], () => undefined)[0]);

  // The roster is text for the model, not a TUI row, so the guarantee is that every
  // variable part is cut to a bounded number of whole user-perceived characters and
  // carries no terminal control, whatever the text holds.
  it("cuts a wide or ANSI-laden error to one clean line of 160 characters", () => {
    const wide = `\x1b[31m${"漢字".repeat(200)}\x1b[0m\nnext line`;
    const text = line(saved({ status: "error", error: wide }));
    expect(text).not.toContain("\n");
    // oxlint-disable-next-line no-control-regex -- asserting no escape survives
    expect(text).not.toMatch(/\x1b/);
    const error = text.split("last run failed: ")[1];
    expect(
      Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(error)),
    ).toHaveLength(160);
    expect(error.endsWith("…")).toBe(true);
  });

  it("keeps a wide description whole at the cut", () => {
    const text = line(saved({ status: "stopped", description: "界".repeat(100) }));
    expect(text).toContain(`"${"界".repeat(79)}…"`);
  });
});
