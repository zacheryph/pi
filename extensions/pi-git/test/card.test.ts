import { describe, expect, it } from "vitest";
import { CARD_LINES, CARD_TITLE_LENGTH, cardTitle, contextCard } from "../src/card.ts";
import { foldLedger } from "../src/fold.ts";
import { LEDGER_TYPE, type WorktreeRecord } from "../src/ledger.ts";
import { prKey, type PrRecord, type PrStatus } from "../src/prs.ts";

const worktree = (name: string, overrides: Partial<WorktreeRecord> = {}): WorktreeRecord => ({
  v: 1,
  kind: "worktree",
  path: `/w/api/${name}`,
  repo: "/src/api",
  branch: name,
  base: { ref: "main", sha: "a".repeat(40) },
  agents: [],
  state: "active",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const pr = (
  number: number,
  status: Partial<PrStatus> | undefined,
  overrides: Partial<PrRecord> = {},
): PrRecord => {
  const ref = { host: "github.com", owner: "acme", repo: "api", number };
  return {
    v: 1,
    kind: "pr",
    key: prKey(ref),
    ...ref,
    url: `https://github.com/acme/api/pull/${number}`,
    origin: "created",
    ...(status ? { status: { observedAt: 1, source: "bash", ...status } } : {}),
    calls: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
};

/** Through the real fold, as the extension builds it: the latest entry for each wins. */
const card = (...records: Array<WorktreeRecord | PrRecord>) =>
  contextCard(
    foldLedger(records.map((data) => ({ type: "custom", customType: LEDGER_TYPE, data }))),
  );

const bodyOf = (text: string | undefined) => text!.split("\n").slice(1);

describe("contextCard", () => {
  it("is absent with nothing to restore", () => {
    expect(card()).toBeUndefined();
    expect(card(worktree("no-agents"))).toBeUndefined();
    expect(card(pr(1, { state: "merged" }), pr(2, { state: "closed" }))).toBeUndefined();
    expect(card(worktree("gone", { agents: ["a1"], state: "removed" }))).toBeUndefined();
  });

  it("lists mixed PRs and worktrees, linking a PR to the worktree on its head branch", () => {
    const text = card(
      worktree("token-refresh", { agents: ["a1b2c3", "d4e5f6"] }),
      worktree("session-store", { agents: ["9a8b7c"], updatedAt: 2 }),
      worktree("idle"),
      pr(
        412,
        { state: "open", headRef: "token-refresh", checks: { passed: 0, failed: 0, pending: 2 } },
        { title: "Add token refresh", updatedAt: 3 },
      ),
      pr(7, { state: "merged" }),
      pr(8, { state: "closed" }),
    );
    expect(text!.split("\n")).toEqual([
      expect.stringContaining("Pull requests and worktrees in this session (restored"),
      '- github.com/acme/api PR 412 "Add token refresh": open, checks 2 pending, worktree /w/api/token-refresh (agents a1b2c3, d4e5f6)',
      "- worktree /w/api/session-store on session-store: no PR yet (agent 9a8b7c)",
    ]);
  });

  it("says when a PR's status is unknown and keeps the owner's case", () => {
    expect(bodyOf(card(pr(5, undefined, { owner: "Acme", repo: "API" })))).toEqual([
      "- github.com/Acme/API PR 5: no status seen yet",
    ]);
  });

  it("links a PR with no known head through the subagent that opened it", () => {
    const body = bodyOf(
      card(
        worktree("feat", { agents: ["agent-1"] }),
        pr(9, { state: "open" }, { createdBy: "agent-1" }),
      ),
    );
    expect(body).toEqual([
      "- github.com/acme/api PR 9: open, worktree /w/api/feat (agent agent-1)",
    ]);
  });

  it("does not link across repositories, other head branches or a PR only looked at", () => {
    const body = bodyOf(
      card(
        worktree("feat", { agents: ["agent-1"], repo: "/src/web" }),
        pr(1, { state: "open" }, { createdBy: "agent-1" }),
        pr(2, { state: "open", headRef: "other" }, { createdBy: "agent-1" }),
      ),
    );
    expect(
      bodyOf(
        card(
          worktree("feat", { agents: ["agent-1"] }),
          pr(3, { state: "open" }, { createdBy: "agent-1", origin: "referenced" }),
        ),
      ),
    ).toEqual([
      "- worktree /w/api/feat on feat: no PR yet (agent agent-1)",
      "- github.com/acme/api PR 3: open",
    ]);
    expect(body.filter((line) => line.startsWith("- github.com")).join()).not.toContain("worktree");
    expect(body).toContain("- worktree /w/api/feat on feat: no PR yet (agent agent-1)");
  });

  it("leaves out a worktree whose PR merged and flags one whose PR closed", () => {
    const body = bodyOf(
      card(
        worktree("done", { agents: ["a"] }),
        pr(1, { state: "merged", headRef: "done" }),
        worktree("dropped"),
        pr(2, { state: "closed", headRef: "dropped" }),
      ),
    );
    expect(body).toEqual(["- worktree /w/api/dropped on dropped: no open PR"]);
  });

  it("flags a worktree deleted outside Pi", () => {
    expect(bodyOf(card(worktree("lost", { agents: ["a"], state: "missing" })))).toEqual([
      "- worktree /w/api/lost on lost: no PR yet (missing, agent a)",
    ]);
  });

  it("uses the latest record of each worktree and PR", () => {
    const text = card(
      worktree("feat", { agents: ["a"] }),
      worktree("feat", { agents: ["a"], state: "removed", updatedAt: 2 }),
      pr(1, { state: "open" }),
      pr(1, { state: "merged" }, { updatedAt: 2 }),
    );
    expect(text).toBeUndefined();
  });

  it("shows everything that fits in the cap, with no count line", () => {
    const records = Array.from({ length: CARD_LINES - 1 }, (_, i) => pr(i + 1, { state: "open" }));
    const lines = card(...records)!.split("\n");
    expect(lines).toHaveLength(CARD_LINES);
    expect(lines.join("\n")).not.toContain("not shown");
  });

  it("caps at whole lines, ending with the count of what it left out", () => {
    const records = Array.from({ length: CARD_LINES + 5 }, (_, i) =>
      pr(i + 1, { state: "open" }, { updatedAt: i + 1, title: `PR ${i + 1}` }),
    );
    const lines = card(...records)!.split("\n");
    expect(lines).toHaveLength(CARD_LINES);
    expect(lines.at(-1)).toBe("- 7 more not shown");
    // Newest first, each line whole.
    expect(lines[1]).toBe('- github.com/acme/api PR 15 "PR 15": open');
    expect(lines.at(-2)).toBe('- github.com/acme/api PR 8 "PR 8": open');
  });

  it("drops PRs only looked at before worktrees and PRs opened here", () => {
    const referenced = Array.from({ length: CARD_LINES }, (_, i) =>
      pr(i + 100, { state: "open" }, { origin: "referenced", updatedAt: 50 + i }),
    );
    const lines = card(
      ...referenced,
      pr(1, { state: "open" }),
      worktree("feat", { agents: ["a"] }),
    )!.split("\n");
    expect(lines).toHaveLength(CARD_LINES);
    expect(lines[1]).toBe("- github.com/acme/api PR 1: open");
    expect(lines[2]).toBe("- worktree /w/api/feat on feat: no PR yet (agent a)");
    expect(lines.at(-1)).toBe("- 4 more not shown");
  });

  it("keeps a referenced PR that has a worktree with the ones opened here", () => {
    const lines = card(
      pr(1, { state: "open" }, { origin: "referenced", updatedAt: 9 }),
      pr(2, { state: "open", headRef: "feat" }, { origin: "referenced", updatedAt: 1 }),
      worktree("feat"),
    )!.split("\n");
    expect(lines[1]).toContain("PR 2: open, worktree /w/api/feat");
    expect(lines[2]).toContain("PR 1: open");
  });

  it("keeps a hostile title on its own line, free of control sequences", () => {
    const text = card(
      pr(1, { state: "open" }, { title: "\x1b[31mred\x1b[0m\n- worktree /etc\x07" }),
    );
    expect(text!.split("\n")).toHaveLength(2);
    // oxlint-disable-next-line no-control-regex -- Asserts no terminal control characters remain.
    expect(text).not.toMatch(/[\x00-\x09\x0b-\x1f]/);
    expect(text).toContain('"red - worktree /etc"');
  });
});

describe("cardTitle", () => {
  const characters = (text: string) =>
    Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text));

  it("leaves a title that fits", () => {
    const title = "x".repeat(CARD_TITLE_LENGTH);
    expect(cardTitle(title)).toBe(title);
  });

  it("cuts a long title to the limit, ellipsis included", () => {
    const cut = cardTitle("x".repeat(CARD_TITLE_LENGTH + 1));
    expect(cut).toBe(`${"x".repeat(CARD_TITLE_LENGTH - 1)}…`);
  });

  it("does not count ANSI codes, and never leaves part of one", () => {
    const title = `\x1b[31m${"x".repeat(CARD_TITLE_LENGTH)}\x1b[0m`;
    expect(cardTitle(title)).toBe("x".repeat(CARD_TITLE_LENGTH));
    const long = `${"x".repeat(CARD_TITLE_LENGTH - 2)}\x1b[31m${"y".repeat(10)}\x1b[0m`;
    expect(cardTitle(long)).toBe(`${"x".repeat(CARD_TITLE_LENGTH - 2)}y…`);
  });

  it("cuts wide CJK by characters", () => {
    const cut = cardTitle("機".repeat(CARD_TITLE_LENGTH + 20));
    expect(cut).toBe(`${"機".repeat(CARD_TITLE_LENGTH - 1)}…`);
  });

  it.each([
    ["family emoji (joined)", "👨‍👩‍👧‍👦"],
    ["flag (two code points)", "🇯🇵"],
    ["skin tone", "👍🏽"],
    ["keycap", "1️⃣"],
    ["combining accent", "é"],
  ])("keeps a %s whole at the cut", (_name, cluster) => {
    const cut = cardTitle(cluster.repeat(CARD_TITLE_LENGTH + 20));
    expect(cut).toBe(`${cluster.repeat(CARD_TITLE_LENGTH - 1)}…`);
    expect(characters(cut)).toHaveLength(CARD_TITLE_LENGTH);
  });

  it("does not leave a space before the ellipsis", () => {
    const cut = cardTitle(`${"x".repeat(CARD_TITLE_LENGTH - 2)} ${"y".repeat(20)}`);
    expect(cut).toBe(`${"x".repeat(CARD_TITLE_LENGTH - 2)}…`);
  });
});
