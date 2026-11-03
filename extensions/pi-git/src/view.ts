/**
 * view.ts — plain-text listings for tools and non-interactive modes, and the
 * `/git:worktrees` explorer. Paths, branch names and errors are untrusted text;
 * pi-ui sanitizes them in the explorer, and tool output is plain text.
 */

import { basename } from "node:path";
import type { Block, ExplorerItem, ExplorerView, Tone } from "../../../packages/pi-ui/src/index.ts";
import type { GitSnapshotEvent, GitSnapshotWorktree } from "./events.ts";
import type { FoundWorktree } from "./worktrees.ts";
import { atRisk, describeStatus } from "./worktrees.ts";

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
