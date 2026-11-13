// Slots 2 and 3: the context row segment, and the thread context card's row and section.
import {
  experimental_ThreadContextCardRow as ThreadContextCardRow,
  useBbNavigate,
  type ExperimentalThreadContextCardProps,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import type { GitSection, SessionSnapshot } from "../contract.ts";
import { prNumber, runningAgents, todoCounts } from "./format.ts";
import { useOpenSessionTab, useSession } from "./session.ts";

/** `orchestrate · 3/7 tasks · 2 agents`, as one button that opens the Pi tab. */
export function SegmentSummary({
  snapshot,
  onOpen,
}: {
  snapshot: SessionSnapshot;
  onOpen?: () => void;
}) {
  const counts = todoCounts(snapshot.todos);
  const agents = runningAgents(snapshot);
  const parts = [
    snapshot.agent ?? "Pi",
    ...(counts ? [`${counts.done}/${counts.total} tasks`] : []),
    ...(agents ? [`${agents} ${agents === 1 ? "agent" : "agents"}`] : []),
    ...(snapshot.questions?.length ? ["question"] : []),
  ];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="inline-flex min-w-0 items-center gap-1.5 rounded px-1 text-xs text-muted-foreground hover:text-foreground"
      title="Open the Pi session tab"
    >
      <Icon name="Layers" className="size-3.5 shrink-0" />
      <span className="truncate">{parts.join(" · ")}</span>
    </button>
  );
}

export function PiSegment({ threadId }: ExperimentalThreadContextSegmentProps) {
  const snapshot = useSession(threadId);
  const open = useOpenSessionTab();
  return snapshot ? <SegmentSummary snapshot={snapshot} onOpen={() => void open()} /> : null;
}

export function StashCardRow({ threadId }: ExperimentalThreadContextCardProps) {
  const snapshot = useSession(threadId);
  const open = useOpenSessionTab();
  const total = snapshot?.stash?.total ?? 0;
  if (!total) return null;
  return (
    <ThreadContextCardRow
      icon="Paperclip"
      label="Stash"
      trailing={<span className="tabular-nums">{total}</span>}
      title={`${total} stash ${total === 1 ? "entry" : "entries"} on this branch`}
      onClick={() => void open()}
    />
  );
}

function checksText(checks: NonNullable<GitSection["prs"][number]["checks"]>): string {
  const parts = [
    ...(checks.passed ? [`✓${checks.passed}`] : []),
    ...(checks.failed ? [`✗${checks.failed}`] : []),
    ...(checks.pending ? [`●${checks.pending}`] : []),
  ];
  return parts.join(" ");
}

function prIcon(pr: GitSection["prs"][number]): string {
  if (pr.state === "merged") return "GitMerge";
  if (pr.state === "closed") return "GitPullRequestClosed";
  return pr.draft ? "GitPullRequestDraft" : "GitPullRequest";
}

function worktreeText(worktree: GitSection["worktrees"][number]): string {
  if (worktree.state === "missing") return "missing";
  if (worktree.mergedInto) return `merged into ${worktree.mergedInto}`;
  const parts = [
    ...(worktree.dirty ? ["dirty"] : []),
    ...(worktree.unpushed ? [`${worktree.unpushed} unpushed`] : []),
  ];
  return parts.join(" · ") || "clean";
}

export function GitRows({ git, openUrl }: { git: GitSection; openUrl?: (url: string) => void }) {
  return (
    <>
      {git.worktrees.map((worktree) => (
        <ThreadContextCardRow
          key={worktree.path}
          icon="FolderGit"
          label={worktree.branch}
          title={`${worktree.repo}: ${worktree.path}`}
          trailing={<span className="text-xs">{worktreeText(worktree)}</span>}
        />
      ))}
      {git.prs.map((pr) => (
        <ThreadContextCardRow
          key={pr.url}
          icon={prIcon(pr)}
          label={`${prNumber(pr.label)} ${pr.title ?? ""}`.trim()}
          title={`${pr.label}${pr.state ? ` (${pr.draft ? "draft" : pr.state})` : ""}`}
          trailing={
            pr.checks ? (
              <span className="font-mono text-xs tabular-nums">{checksText(pr.checks)}</span>
            ) : undefined
          }
          {...(openUrl ? { onClick: () => openUrl(pr.url) } : {})}
        />
      ))}
    </>
  );
}

export function GitCardSection({ threadId }: ExperimentalThreadContextCardProps) {
  const snapshot = useSession(threadId);
  const navigate = useBbNavigate();
  const git = snapshot?.git;
  if (!git || git.worktrees.length + git.prs.length === 0) return null;
  return <GitRows git={git} openUrl={(url) => void navigate.openUrl(url)} />;
}
