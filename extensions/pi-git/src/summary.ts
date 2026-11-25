/**
 * summary.ts — the `git.summary` view: this session's worktree and pull request totals, from
 * the same snapshot as the `git.worktrees` and `git.prs` explorers. The
 * explorers list records; this carries the totals no single item does, such as how many pull
 * requests opened here are still open and how many of those fail their checks.
 */

import { plural } from "#foundations/format";
import type { SummaryCount, SummaryModel } from "#surface";
import type { GitSnapshot } from "#src/snapshot";

/**
 * Every count is present, zero included, so a session with no worktrees or pull requests
 * reads zeros where one without pi-git has no view. Worktree and pull request records live
 * in the session's ledger, and a status is the last one measured or seen, so they are never
 * process-bound. Only `prs-watching` is: a `git_pr_watch` waits only while this process runs.
 * Noun labels agree with their value ("1 worktree", "2 worktrees"); the others are states that
 * read the same for any value.
 */
export function gitSummaryModel(snapshot: GitSnapshot): SummaryModel {
  const inUse = snapshot.worktrees.filter((worktree) => worktree.state !== "removed");
  const created = snapshot.prs.filter((pr) => pr.origin === "created");
  const open = created.filter(
    (pr) => pr.status?.state !== "merged" && pr.status?.state !== "closed",
  );
  const counts: SummaryCount[] = [
    { key: "worktrees", label: plural(inUse.length, "worktree"), value: inUse.length },
    {
      key: "missing",
      label: "missing",
      value: inUse.filter((worktree) => worktree.state === "missing").length,
      tone: "warning",
    },
    {
      key: "uncommitted",
      label: "uncommitted",
      value: inUse.filter((worktree) => worktree.state === "active" && worktree.status?.dirty)
        .length,
      tone: "warning",
    },
    {
      key: "removed",
      label: "removed",
      value: snapshot.worktrees.length - inUse.length,
      tone: "dim",
    },
    {
      key: "other-worktrees",
      label: plural(snapshot.found.length, "other worktree"),
      value: snapshot.found.length,
      tone: "dim",
    },
    { key: "prs", label: plural(snapshot.prs.length, "pull request"), value: snapshot.prs.length },
    { key: "prs-created", label: "opened here", value: created.length },
    { key: "prs-open", label: "open", value: open.length, tone: "accent" },
    {
      key: "prs-failing",
      label: "failing",
      value: open.filter((pr) => (pr.status?.checks?.failed ?? 0) > 0).length,
      tone: "error",
    },
    {
      key: "prs-watching",
      label: "watching",
      value: snapshot.prs.filter((pr) => pr.watch).length,
      live: true,
    },
  ];
  return { counts };
}
