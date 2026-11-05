import { describe, expect, it, vi } from "vitest";
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

function saved(overrides: Partial<PersistedSubagentRecord> = {}): PersistedSubagentRecord {
  return {
    id: "a1",
    type: "implementer",
    description: "Add token refresh",
    status: "completed",
    result: "done",
    error: undefined,
    turnBudget: undefined,
    startedAt: 1_000,
    completedAt: 2_000,
    outputFile: undefined,
    toolUses: 0,
    ...overrides,
  };
}

const noneLive = () => undefined;

describe("rosterState", () => {
  it.each([
    ["completed", undefined, true, "completed"],
    ["completed", "Which DB?", false, "waiting"],
    ["running", undefined, true, "running"],
    ["queued", undefined, true, "queued"],
    ["running", undefined, false, "interrupted"],
    ["queued", undefined, false, "interrupted"],
    ["error", undefined, false, "error"],
    ["aborted", "Which DB?", false, "aborted"],
    ["stopped", undefined, true, "stopped"],
  ] as const)("%s, question %s, live %s → %s", (status, question, live, expected) => {
    expect(rosterState(status, question, live)).toBe(expected);
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
    const live: LiveAgentLike = { ...record, status: "completed", completedAt: 9_000 };
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
      `- a1 implementer "Add token refresh": completed ${formatClock(7_200_000)}`,
    );
  });

  it("names the error, the exhausted budget, a stop and an interruption", () => {
    expect(line(saved({ status: "error", error: "boom\nstack" }))).toContain("failed: boom stack");
    expect(line(saved({ status: "aborted" }))).toContain("failed: turn budget exhausted");
    expect(line(saved({ status: "stopped" }))).toContain("stopped before it finished");
    expect(line(saved({ status: "running" }))).toContain(
      "interrupted: the session was reloaded or replaced before it finished",
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
        "Subagents started by this session (restored after compaction; subagent_get <id> for details):",
        '- 9a8b7c implementer "Migrate store": waiting for your answer: "Postgres?"',
        '- d4e5f6 review "Review step 3": running',
        '- 77e0aa explorer "Map auth call sites": failed: turn budget exhausted',
        `- a1b2c3 implementer "Add token refresh": completed ${formatClock(50_000_000)}`,
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
      expect(lines[18]).toContain("failed: ");
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
      "Agents started on this branch (2; subagent_get <id> for details):",
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

describe("buildRoster — whether an agent can be resumed", () => {
  const line = (record: PersistedSubagentRecord, resumable: boolean) =>
    formatRosterLine(
      buildRoster(
        [record],
        () => undefined,
        () => resumable,
      )[0],
    );

  it("says so on a completed line", () => {
    expect(line(saved(), true)).toMatch(/: completed \d\d:\d\d, resumable$/);
    expect(line(saved(), false)).toMatch(/: completed \d\d:\d\d$/);
  });

  it("says so on an interrupted line", () => {
    const interrupted = saved({ status: "running", completedAt: undefined });
    expect(line(interrupted, true)).toMatch(/before it finished, resumable$/);
    expect(line(interrupted, false)).toMatch(/before it finished$/);
  });

  it("warns only when a question cannot be answered", () => {
    const waiting = saved({ pendingQuestion: "Which DB?" });
    expect(line(waiting, true)).toMatch(/"Which DB\?"$/);
    expect(line(waiting, false)).toMatch(/"Which DB\?" \(cannot be resumed\)$/);
  });

  it("does not ask about a failed agent", () => {
    const check = vi.fn(() => true);
    const [entry] = buildRoster(
      [saved({ status: "error", error: "boom" })],
      () => undefined,
      check,
    );
    expect(check).not.toHaveBeenCalled();
    expect(entry.resumable).toBeUndefined();
  });

  it("asks about the live agent when one backs the record", () => {
    const check = vi.fn(() => true);
    const live: LiveAgentLike = { ...saved(), outputFile: "/live.jsonl" };
    buildRoster([saved()], () => live, check);
    expect(check).toHaveBeenCalledWith(live);
  });
});
