/**
 * view.ts — plain-text listings for tools and non-interactive modes, and the
 * `/git:worktrees` explorer. Paths, branch names and errors are untrusted text;
 * pi-ui sanitizes them in the explorer, and tool output is plain text.
 */

import { basename } from "node:path";
import type { Block, ExplorerItem, ExplorerView, Tone } from "#ui";
import type { GitSnapshotEvent, GitSnapshotPr, GitSnapshotWorktree } from "#src/events";
import { describePr, prLabel, type PrReview, type PrState } from "#src/prs";
import { describeWatch } from "#src/watch";
import type { FoundWorktree } from "#src/worktrees";
import { atRisk, describeStatus } from "#src/worktrees";

/** Cap on worktrees listed in tool output and notifications. */
export const LIST_LIMIT = 50;

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** The state, or for an active worktree its git status: "uncommitted changes; merged into main". */
export function statusText(worktree: GitSnapshotWorktree): string {
  if (worktree.state === "removed") return "removed";
  if (worktree.state === "missing") return "missing: deleted outside Pi";
  if (worktree.error) return `status unknown: ${worktree.error}`;
  if (!worktree.status) return "active";
  return describeStatus(worktree.status, worktree.base.ref);
}

function headline(worktree: GitSnapshotWorktree): string {
  const workspace = worktree.workspace ? ` [workspace ${worktree.workspace}]` : "";
  return `${basename(worktree.repo)} @ ${worktree.branch}${workspace}`;
}

/** The text `git_worktree_list` returns and non-interactive `/git:worktrees` shows. */
export function listText(snapshot: GitSnapshotEvent, includeRemoved: boolean): string {
  const shown = snapshot.worktrees.filter((w) => includeRemoved || w.state !== "removed");
  const lines: string[] = [];
  if (shown.length === 0) lines.push("No worktrees in this session's ledger.");
  for (const worktree of shown.slice(0, LIST_LIMIT)) {
    lines.push(`- ${worktree.path}`);
    lines.push(`  ${headline(worktree)} — ${statusText(worktree)}`);
    if (worktree.agents.length) lines.push(`  agents: ${worktree.agents.map(shortId).join(", ")}`);
  }
  if (shown.length > LIST_LIMIT) lines.push(`…and ${shown.length - LIST_LIMIT} more`);
  const hidden = snapshot.worktrees.length - shown.length;
  if (hidden > 0) lines.push(`(${hidden} removed worktree${hidden === 1 ? "" : "s"} not shown)`);
  if (snapshot.found.length) {
    lines.push("", "Under the worktree root but not in this session's ledger:");
    for (const found of snapshot.found.slice(0, LIST_LIMIT)) lines.push(`- ${foundText(found)}`);
  }
  return lines.join("\n");
}

function foundText(found: FoundWorktree): string {
  return `${found.path} — ${basename(found.repo)}${found.branch ? ` @ ${found.branch}` : ""}`;
}

function stateTone(worktree: GitSnapshotWorktree): Tone {
  if (worktree.state === "missing") return "warning";
  if (worktree.state === "removed") return "dim";
  if (worktree.error) return "warning";
  if (worktree.status && atRisk(worktree.status)) return "warning";
  return "success";
}

function detail(worktree: GitSnapshotWorktree): Block[] {
  return [
    {
      fields: [
        ["Path", worktree.path],
        ["Repository", worktree.repo],
        ["Branch", worktree.branch],
        [
          "Base",
          worktree.base.ref
            ? `${worktree.base.ref} (${worktree.base.sha.slice(0, 12)})`
            : worktree.base.sha.slice(0, 12),
        ],
        ...(worktree.workspacePath ? ([["Workspace", worktree.workspacePath]] as const) : []),
        ["State", { text: statusText(worktree), tone: stateTone(worktree) }],
        ["Created", new Date(worktree.createdAt).toISOString()],
        ...(worktree.createdBy
          ? ([["Created by", `subagent ${worktree.createdBy}`]] as const)
          : []),
      ],
    },
    { heading: "Agents" },
    worktree.agents.length
      ? { bullets: worktree.agents }
      : { text: "No subagent has run here yet.", tone: "muted" },
    { heading: "Use" },
    {
      text: `Hand it to a subagent with subagent_start { cwd: "${worktree.workspacePath ?? worktree.path}" }. Remove it with /git:worktrees remove; its branch is kept.`,
      tone: "muted",
    },
  ];
}

export function explorerView(snapshot: GitSnapshotEvent): ExplorerView {
  const items: ExplorerItem[] = snapshot.worktrees.map((worktree) => ({
    id: worktree.path,
    label: [
      { text: headline(worktree), tone: "accent" },
      { text: ` — ${worktree.path}`, tone: "muted" },
    ],
    search: `${worktree.path} ${worktree.agents.join(" ")}`,
    badge: { text: statusText(worktree), tone: stateTone(worktree) },
    detail: detail(worktree),
  }));
  for (const found of snapshot.found) {
    items.push({
      id: `found:${found.path}`,
      label: [
        {
          text: `${basename(found.repo)}${found.branch ? ` @ ${found.branch}` : ""}`,
          tone: "accent",
        },
        { text: ` — ${found.path}`, tone: "muted" },
      ],
      search: found.path,
      badge: { text: "not in this session" },
      detail: [
        {
          fields: [
            ["Path", found.path],
            ["Repository", found.repo],
            ["Branch", found.branch ?? "(detached)"],
          ],
        },
        {
          text: "Another session created this worktree, or it was added by hand. pi-git can still remove it.",
          tone: "muted",
        },
      ],
    });
  }
  const current = snapshot.worktrees.filter((w) => w.state !== "removed").map((w) => w.path);
  const removed = snapshot.worktrees.filter((w) => w.state === "removed").map((w) => w.path);
  const found = snapshot.found.map((f) => `found:${f.path}`);
  return {
    title: "Git worktrees",
    noun: ["worktree", "worktrees"],
    items,
    tabs: [
      { label: "This session", ids: current, emptyText: "No worktrees in this session." },
      { label: "Removed", ids: removed, emptyText: "Nothing removed in this session." },
      {
        label: "Other",
        ids: found,
        emptyText: "No other worktrees under the worktree root.",
      },
    ],
    hints: [{ keys: "/git:worktrees remove", action: "remove one" }],
  };
}

// ── Pull requests ──────────────────────────────────────────────────────────

function prTone(pr: GitSnapshotPr): Tone {
  const status = pr.status;
  if (!status) return "dim";
  if (status.state === "merged") return "success";
  if (status.state === "closed") return "dim";
  if ((status.checks?.failed ?? 0) > 0 || status.mergeable === false) return "error";
  if (status.review === "changes_requested") return "warning";
  if (status.review === "approved" && !status.checks?.pending) return "success";
  return "default";
}

function observed(pr: GitSnapshotPr, now: number): string {
  return pr.status ? `seen ${age(pr.status.observedAt, now)} ago via ${pr.status.source}` : "";
}

function age(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/** The text `git_pr_list` returns and non-interactive `/git:prs` shows. */
export function prListText(
  prs: readonly GitSnapshotPr[],
  includeReferenced: boolean,
  now = Date.now(),
): string {
  const groups: Array<[string, GitSnapshotPr[]]> = [
    ["Opened here", prs.filter((pr) => pr.origin === "created")],
    ...(includeReferenced
      ? ([["Referenced", prs.filter((pr) => pr.origin === "referenced")]] as Array<
          [string, GitSnapshotPr[]]
        >)
      : []),
  ];
  const lines: string[] = [];
  for (const [heading, group] of groups) {
    if (lines.length) lines.push("");
    lines.push(`${heading}:`);
    if (group.length === 0) lines.push("  (none)");
    for (const pr of group.slice(0, LIST_LIMIT)) {
      lines.push(`- ${prLabel(pr)}${pr.title ? ` — ${pr.title}` : ""}`);
      const seen = observed(pr, now);
      lines.push(`  ${describePr(pr.status)}${seen ? ` (${seen})` : ""}`);
      if (pr.watch) lines.push(`  ${describeWatch(pr.watch, now)}`);
      lines.push(`  ${pr.url}`);
    }
    if (group.length > LIST_LIMIT) lines.push(`…and ${group.length - LIST_LIMIT} more`);
  }
  return lines.join("\n");
}

function prDetail(pr: GitSnapshotPr, now: number): Block[] {
  const status = pr.status;
  return [
    {
      fields: [
        ["URL", pr.url],
        ...(pr.title ? ([["Title", pr.title]] as const) : []),
        ["Status", { text: describePr(status), tone: prTone(pr) }],
        ...(status?.headRef ? ([["Branch", status.headRef]] as const) : []),
        ...(status?.headSha ? ([["Head", status.headSha.slice(0, 12)]] as const) : []),
        ...(status ? ([["Observed", observed(pr, now)]] as const) : []),
        ...(pr.watch ? ([["Watch", describeWatch(pr.watch, now)]] as const) : []),
        ["Origin", pr.origin === "created" ? "opened in this session" : "referenced"],
        ...(pr.createdBy ? ([["Recorded by", `subagent ${pr.createdBy}`]] as const) : []),
      ],
    },
    { heading: "Tool calls" },
    {
      bullets: pr.calls
        .slice()
        .reverse()
        .map(
          (call) =>
            `${call.tool} · ${age(call.at, now)} ago${call.agentId ? ` · subagent ${call.agentId}` : ""}`,
        ),
    },
    {
      text: "Status is what the session's tools last showed. git_pr_status or /git:refresh reads it fresh from GitHub.",
      tone: "muted",
    },
  ];
}

export function prExplorerView(prs: readonly GitSnapshotPr[], now = Date.now()): ExplorerView {
  const items: ExplorerItem[] = prs.map((pr) => ({
    id: pr.key,
    label: [
      { text: prLabel(pr), tone: "accent" },
      ...(pr.title ? [{ text: ` — ${pr.title}`, tone: "muted" as const }] : []),
    ],
    search: `${pr.url} ${pr.status?.headRef ?? ""}`,
    badge: { text: describePr(pr.status), tone: prTone(pr) },
    detail: prDetail(pr, now),
  }));
  return {
    title: "Pull requests",
    noun: ["pull request", "pull requests"],
    items,
    tabs: [
      {
        label: "Opened here",
        ids: prs.filter((pr) => pr.origin === "created").map((pr) => pr.key),
        emptyText: "No pull requests opened in this session.",
      },
      {
        label: "Referenced",
        ids: prs.filter((pr) => pr.origin === "referenced").map((pr) => pr.key),
        emptyText: "No other pull requests looked at in this session.",
      },
    ],
  };
}

/** The text `git_pr_status` returns: one block per pull request read. */
export function prStatusText(
  entries: ReadonlyArray<{
    label: string;
    url: string;
    title?: string;
    state?: string;
    draft?: boolean;
    review?: string;
    checks?: { passed: number; failed: number; pending: number };
    mergeable?: boolean;
    headSha?: string;
    source?: string;
    error?: string;
  }>,
): string {
  const blocks = entries.map((entry) => {
    if (entry.error)
      return `- ${entry.label}: could not read status: ${entry.error}\n  ${entry.url}`;
    const facts = {
      ...(entry.state ? { state: entry.state as PrState } : {}),
      ...(entry.draft !== undefined ? { draft: entry.draft } : {}),
      ...(entry.review ? { review: entry.review as PrReview } : {}),
      ...(entry.checks ? { checks: entry.checks } : {}),
      ...(entry.mergeable !== undefined ? { mergeable: entry.mergeable } : {}),
    };
    const summary = describePr({ ...facts, observedAt: 0, source: entry.source ?? "" });
    const head = entry.headSha ? ` · head ${entry.headSha.slice(0, 12)}` : "";
    return [
      `- ${entry.label}${entry.title ? ` — ${entry.title}` : ""}`,
      `  ${summary}${head} (via ${entry.source ?? "unknown"})`,
      `  ${entry.url}`,
    ].join("\n");
  });
  return blocks.join("\n");
}
