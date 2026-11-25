import { describe, expect, it } from "vitest";
import { isViewModel, settleViews, type SummaryModel, type ViewEntry } from "#surface";
import type { GitSnapshot, GitSnapshotPr, GitSnapshotWorktree } from "#src/snapshot";
import { gitSummaryModel } from "#src/summary";
import { explorerView, LIST_LIMIT, listText, prExplorerView, prListText } from "#src/view";

const NOW = Date.UTC(2026, 10, 3);

const worktree = (overrides: Partial<GitSnapshotWorktree> = {}): GitSnapshotWorktree => ({
  path: "/w/api/feat-login",
  repo: "/src/api",
  branch: "feat/login",
  base: { ref: "main", sha: "a".repeat(40) },
  agents: [],
  state: "active",
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const pr = (number: number, overrides: Partial<GitSnapshotPr> = {}): GitSnapshotPr => ({
  key: `github.com/acme/api#${number}`,
  host: "github.com",
  owner: "acme",
  repo: "api",
  number,
  url: `https://github.com/acme/api/pull/${number}`,
  origin: "created",
  status: { state: "open", observedAt: NOW, source: "bash" },
  calls: [{ tool: "bash", toolCallId: `c${number}`, at: NOW }],
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const counts = (model: SummaryModel) =>
  Object.fromEntries(model.counts.map((count) => [count.key, count.value]));
const labels = (model: SummaryModel) =>
  Object.fromEntries(model.counts.map((count) => [count.key, count.label]));

describe("gitSummaryModel", () => {
  it("reads zeros for a session with nothing recorded", () => {
    const model = gitSummaryModel({ worktrees: [], found: [], prs: [] });
    expect(isViewModel("summary", model)).toBe(true);
    expect(counts(model)).toEqual({
      worktrees: 0,
      missing: 0,
      uncommitted: 0,
      removed: 0,
      "other-worktrees": 0,
      prs: 0,
      "prs-created": 0,
      "prs-open": 0,
      "prs-failing": 0,
      "prs-watching": 0,
    });
  });

  it("counts every record, past the rows any listing shows", () => {
    const many = LIST_LIMIT + 5;
    const snapshot: GitSnapshot = {
      worktrees: [
        ...Array.from({ length: many }, (_, i) => worktree({ path: `/w/${i}` })),
        worktree({
          path: "/w/dirty",
          status: { dirty: true, detached: 0, unpushed: 0, merged: false },
        }),
        worktree({ path: "/w/gone", state: "missing" }),
        worktree({ path: "/w/old", state: "removed" }),
      ],
      found: [{ path: "/w/x/y", repo: "/src/web" }],
      prs: [
        ...Array.from({ length: many }, (_, i) => pr(i + 1)),
        pr(900, {
          status: {
            state: "open",
            checks: { passed: 1, failed: 2, pending: 0 },
            observedAt: 0,
            source: "bash",
          },
        }),
        pr(901, { status: { state: "merged", observedAt: 0, source: "bash" } }),
        pr(902, { status: { state: "closed", observedAt: 0, source: "bash" } }),
        // Failing checks on a merged pull request no longer count as failing.
        pr(903, {
          status: {
            state: "merged",
            checks: { passed: 0, failed: 1, pending: 0 },
            observedAt: 0,
            source: "bash",
          },
        }),
        pr(904, { origin: "referenced" }),
      ],
    };
    expect(listText(snapshot, false)).toContain(`…and ${many + 2 - LIST_LIMIT} more`);
    expect(prListText(snapshot.prs, true)).toContain("more");
    expect(counts(gitSummaryModel(snapshot))).toEqual({
      worktrees: many + 2,
      missing: 1,
      uncommitted: 1,
      removed: 1,
      "other-worktrees": 1,
      prs: many + 5,
      "prs-created": many + 4,
      "prs-open": many + 1,
      "prs-failing": 1,
      "prs-watching": 0,
    });
    // The explorers carry every record too, by path and by key.
    expect(explorerView(snapshot).items).toHaveLength(snapshot.worktrees.length + 1);
    expect(prExplorerView(snapshot.prs).items).toHaveLength(snapshot.prs.length);
  });

  it("labels nouns in agreement with their value, and states the same for any value", () => {
    const states = {
      missing: "missing",
      uncommitted: "uncommitted",
      removed: "removed",
      "prs-created": "opened here",
      "prs-open": "open",
      "prs-failing": "failing",
      "prs-watching": "watching",
    };
    expect(labels(gitSummaryModel({ worktrees: [], found: [], prs: [] }))).toEqual({
      worktrees: "worktrees",
      "other-worktrees": "other worktrees",
      prs: "pull requests",
      ...states,
    });
    const one = gitSummaryModel({
      worktrees: [worktree()],
      found: [{ path: "/w/x/y", repo: "/src/web" }],
      prs: [pr(1)],
    });
    expect(labels(one)).toEqual({
      worktrees: "worktree",
      "other-worktrees": "other worktree",
      prs: "pull request",
      ...states,
    });
    const two = gitSummaryModel({
      worktrees: [worktree(), worktree({ path: "/w/2" })],
      found: [
        { path: "/w/x/y", repo: "/src/web" },
        { path: "/w/x/z", repo: "/src/web" },
      ],
      prs: [pr(1), pr(2)],
    });
    expect(labels(two)).toEqual({
      worktrees: "worktrees",
      "other-worktrees": "other worktrees",
      prs: "pull requests",
      ...states,
    });
    expect(two.counts.some((count) => count.unit)).toBe(false);
  });

  it("marks only the watches as process-bound: settled, records stay and watching reads 0", () => {
    const model = gitSummaryModel({
      worktrees: [worktree()],
      found: [],
      prs: [pr(1, { watch: { until: "settled", since: NOW, deadline: NOW + 60_000 } }), pr(2)],
    });
    expect(model.counts.filter((count) => count.live).map((count) => count.key)).toEqual([
      "prs-watching",
    ]);
    const saved: ViewEntry[] = [{ id: "git.summary", kind: "summary", title: "Git", model }];
    const [settled] = settleViews(saved, NOW);
    expect(counts(settled!.model as SummaryModel)).toEqual({
      ...counts(model),
      "prs-watching": 0,
    });
    expect(counts(model)["prs-watching"]).toBe(1);
  });
});
