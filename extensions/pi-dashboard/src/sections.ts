import { GIT_SNAPSHOT_VERSION, type GitSnapshotEvent } from "#git/events";
import {
  STASH_SNAPSHOT_VERSION,
  type StashPreviewResult,
  type StashSnapshotEvent,
} from "#stash/events";
import { TODO_SNAPSHOT_VERSION, type TodoSnapshotEvent } from "#todo/events";
import type {
  GitSection,
  StashPreview,
  StashSection,
  TodoHistory,
  TodoSection,
} from "#src/protocol";

// Producers own the in-process contracts. These projections bound data for the
// hub connection rather than revalidating the producers' internal state.
const MAX_MESSAGE = 2_000;
const MAX_UPDATES = 20;
const MAX_TASKS = 100;
const MAX_STASH_ENTRIES = 100;
const MAX_SUBJECT = 160;
const MAX_TEXT = 500;
const MAX_KEY = 64;

/** Keeps line breaks, drops other controls, trims and caps. */
export function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/\r\n?/g, "\n")
    // oxlint-disable-next-line no-control-regex -- Intentionally matches terminal control characters.
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function readTodos(data: TodoSnapshotEvent | undefined): TodoSection | undefined {
  if (data?.version !== TODO_SNAPSHOT_VERSION) return undefined;
  const tasks: TodoSection["tasks"] = [];
  for (const raw of data.tasks.slice(0, MAX_TASKS)) {
    const key = clip(raw.key, MAX_KEY);
    const subject = clip(raw.subject, MAX_SUBJECT);
    if (!key || !subject) continue;
    const latest = raw.updates.findLast((update) => update.message !== undefined);
    const message = clip(latest?.message, MAX_TEXT);
    const description = clip(raw.description, MAX_TEXT);
    const dependsOn = (raw.dependsOn ?? [])
      .flatMap((item) => clip(item, MAX_KEY) ?? [])
      .slice(0, 20);
    const updatedAt = raw.updates.at(-1)?.at ?? raw.createdAt;
    tasks.push({
      key,
      subject,
      status: raw.status,
      blocked: raw.blocked,
      unreviewed: raw.unreviewed,
      ...(description ? { description } : {}),
      ...(dependsOn.length ? { dependsOn } : {}),
      ...(message && latest ? { message: { text: message, at: latest.at } } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    });
  }
  return { revision: data.revision, total: data.tasks.length, tasks };
}

export function readStash(data: StashSnapshotEvent | undefined): StashSection | undefined {
  if (data?.version !== STASH_SNAPSHOT_VERSION) return undefined;
  const entries: StashSection["entries"] = [];
  for (const raw of data.entries.slice(0, MAX_STASH_ENTRIES)) {
    const name = clip(raw.name, MAX_KEY);
    const handle = clip(raw.handle, 128);
    if (!name || !handle) continue;
    const description = clip(raw.description, MAX_TEXT);
    entries.push({
      name,
      handle,
      bytes: raw.bytes,
      lines: raw.lines,
      createdAt: raw.createdAt,
      mime: clip(raw.mime, 64) ?? "text/plain",
      source: clip(raw.source, 200) ?? "content",
      createdBy: clip(raw.createdBy, 128) ?? "",
      versions: raw.versions,
      ...(description ? { description } : {}),
    });
  }
  return {
    total: data.entries.length,
    entries,
    ...(data.store ? { store: { ...data.store } } : {}),
  };
}

/** One task's history from pi-todo's latest snapshot event. */
export function readTodoHistory(
  data: TodoSnapshotEvent | undefined,
  key: string,
): TodoHistory | undefined {
  if (data?.version !== TODO_SNAPSHOT_VERSION) return undefined;
  const task = data.tasks.find((candidate) => candidate.key === key);
  if (!task) return undefined;
  return {
    key,
    ...(task.createdAt !== undefined ? { createdAt: task.createdAt } : {}),
    updates: task.updates.slice(-MAX_UPDATES).map((raw) => {
      const message = clip(raw.message, MAX_MESSAGE);
      return {
        revision: raw.revision,
        at: raw.at,
        status: raw.status,
        ...(raw.from ? { from: raw.from } : {}),
        ...(message ? { message } : {}),
        ...(raw.by === "user" ? { byUser: true } : {}),
      };
    }),
  };
}

/** Bounds pi-stash's preview answer before it leaves the process. */
export function readPreview(data: StashPreviewResult | undefined): StashPreview | string {
  if (!data) return "pi-stash did not answer; is it loaded?";
  if (!data.ok) return data.error.slice(0, 500);
  return {
    handle: data.handle,
    lines: data.lines.slice(0, 200).map((line) => line.slice(0, 2_000)),
    total: data.total,
    complete: data.complete,
  };
}

const MAX_WORKTREES = 50;
const MAX_PRS = 50;
/** PRs read for the card counts; a larger ledger is not a session's working set. */
const MAX_PRS_READ = 1000;
const PR_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;

function lastSegment(path: string): string {
  return path.split(/[\\/]/).findLast(Boolean) ?? path;
}

/** Typed producer state, bounded for the wire and restricted to safe PR links. */
export function readGit(data: GitSnapshotEvent | undefined): GitSection | undefined {
  if (data?.version !== GIT_SNAPSHOT_VERSION) return undefined;
  const live = data.worktrees.filter((raw) => raw.state !== "removed");
  const worktrees: GitSection["worktrees"] = [];
  for (const raw of live.slice(0, MAX_WORKTREES)) {
    const path = clip(raw.path, MAX_TEXT);
    const repo = clip(lastSegment(raw.repo), MAX_KEY);
    const branch = clip(raw.branch, MAX_SUBJECT);
    if (!path || !repo || !branch) continue;
    const workspace = clip(raw.workspace, MAX_KEY);
    const base = clip(raw.base.ref, MAX_SUBJECT);
    worktrees.push({
      path,
      repo,
      branch,
      ...(workspace ? { workspace } : {}),
      state: raw.state === "active" ? "active" : "missing",
      agents: raw.agents.length,
      ...(raw.status?.dirty !== undefined ? { dirty: raw.status.dirty } : {}),
      ...(raw.status?.unpushed ? { unpushed: raw.status.unpushed } : {}),
      ...(raw.status?.merged && base ? { mergedInto: base } : {}),
    });
  }
  const all: GitSection["prs"] = [];
  for (const raw of data.prs.slice(0, MAX_PRS_READ)) {
    if (!PR_URL.test(raw.url)) continue;
    const owner = clip(raw.owner, MAX_KEY);
    const repo = clip(raw.repo, MAX_KEY);
    if (!owner || !repo) continue;
    const status = raw.status;
    const title = clip(raw.title, MAX_SUBJECT);
    all.push({
      label: `${owner}/${repo}#${raw.number}`,
      url: raw.url,
      ...(title ? { title } : {}),
      origin: raw.origin,
      ...(status?.state ? { state: status.state } : {}),
      ...(status?.draft !== undefined ? { draft: status.draft } : {}),
      ...(status?.review && status.review !== "none" ? { review: status.review } : {}),
      ...(status?.checks ? { checks: { ...status.checks } } : {}),
      ...(status?.mergeable !== undefined ? { mergeable: status.mergeable } : {}),
      ...(status ? { observedAt: status.observedAt } : {}),
      ...(raw.watch?.until === "settled" || raw.watch?.until === "merged"
        ? { watching: raw.watch.until }
        : {}),
    });
  }
  const openCreated = all.filter(
    (pr) => pr.origin === "created" && pr.state !== "merged" && pr.state !== "closed",
  );
  const prs = [
    ...all.filter((pr) => pr.origin === "created"),
    ...all.filter((pr) => pr.origin === "referenced"),
  ].slice(0, MAX_PRS);
  const removed = data.worktrees.filter((raw) => raw.state === "removed").length;
  if (live.length === 0 && data.prs.length === 0 && removed === 0 && data.found.length === 0)
    return undefined;
  return {
    worktrees,
    worktreeTotal: live.length,
    removed,
    other: data.found.length,
    prs,
    prTotal: data.prs.length,
    openCreated: openCreated.length,
    failingCreated: openCreated.filter((pr) => (pr.checks?.failed ?? 0) > 0).length,
  };
}
