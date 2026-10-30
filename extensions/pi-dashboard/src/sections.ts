import type { StashPreview, StashSection, TodoHistory, TodoSection, TodoStatus } from "./protocol.ts";

// Other extensions publish their state on the session's pi.events bus. The
// payloads are parsed defensively and bounded, so a large or malformed
// emission cannot bloat or break the hub connection.

/** pi-todo: `src/events.ts`. */
export const TODO_SNAPSHOT_EVENT = "pi-todo:snapshot";
/** pi-stash: `src/events.ts`. */
export const STASH_SNAPSHOT_EVENT = "pi-stash:snapshot";
/** pi-stash: synchronous request for the head of one entry on this branch. */
export const STASH_PREVIEW_REQUEST = "pi-stash:preview";
const MAX_MESSAGE = 2_000;
const MAX_UPDATES = 20;

const MAX_TASKS = 100;
const MAX_STASH_ENTRIES = 100;
const MAX_SUBJECT = 160;
const MAX_TEXT = 500;
const MAX_KEY = 64;
const STATUSES: ReadonlySet<unknown> = new Set(["pending", "in_progress", "completed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function time(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Keeps line breaks, drops other control characters, trims and caps. */
export function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function readTodos(data: unknown): TodoSection | undefined {
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.tasks)) return undefined;
  const tasks: TodoSection["tasks"] = [];
  for (const raw of data.tasks.slice(0, MAX_TASKS)) {
    if (!isRecord(raw) || !STATUSES.has(raw.status)) continue;
    const key = clip(raw.key, MAX_KEY);
    const subject = clip(raw.subject, MAX_SUBJECT);
    if (!key || !subject) continue;
    const updates = Array.isArray(raw.updates) ? raw.updates.filter(isRecord) : [];
    const latest = updates.findLast((update) => typeof update.message === "string");
    const message = latest ? clip(latest.message, MAX_TEXT) : undefined;
    const description = clip(raw.description, MAX_TEXT);
    const dependsOn = Array.isArray(raw.dependsOn) ? raw.dependsOn.flatMap((item) => clip(item, MAX_KEY) ?? []).slice(0, 20) : [];
    const updatedAt = time(updates.at(-1)?.at) ?? time(raw.createdAt);
    tasks.push({
      key, subject, status: raw.status as TodoStatus, blocked: raw.blocked === true, unreviewed: count(raw.unreviewed) ?? 0,
      ...(description ? { description } : {}),
      ...(dependsOn.length ? { dependsOn } : {}),
      ...(message ? { message: { text: message, ...(time(latest?.at) ? { at: time(latest?.at) } : {}) } } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    });
  }
  return { revision: count(data.revision) ?? 0, total: data.tasks.length, tasks };
}

export function readStash(data: unknown): StashSection | undefined {
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.entries)) return undefined;
  const entries: StashSection["entries"] = [];
  for (const raw of data.entries.slice(0, MAX_STASH_ENTRIES)) {
    if (!isRecord(raw)) continue;
    const name = clip(raw.name, MAX_KEY);
    const handle = clip(raw.handle, 128);
    const bytes = count(raw.bytes);
    const lines = count(raw.lines);
    const createdAt = time(raw.createdAt);
    if (!name || !handle || bytes === undefined || lines === undefined || !createdAt) continue;
    const description = clip(raw.description, MAX_TEXT);
    entries.push({
      name, handle, bytes, lines, createdAt,
      mime: clip(raw.mime, 64) ?? "text/plain",
      source: clip(raw.source, 200) ?? "content",
      createdBy: clip(raw.createdBy, 128) ?? "",
      versions: count(raw.versions) ?? 1,
      ...(description ? { description } : {}),
    });
  }
  const store = isRecord(data.store) ? data.store : undefined;
  const bytes = count(store?.bytes);
  const maxBytes = count(store?.maxBytes);
  return { total: data.entries.length, entries, ...(bytes !== undefined && maxBytes ? { store: { bytes, maxBytes } } : {}) };
}

/** One task's history from pi-todo's latest snapshot event. */
export function readTodoHistory(data: unknown, key: string): TodoHistory | undefined {
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.tasks)) return undefined;
  const task = data.tasks.find((candidate) => isRecord(candidate) && candidate.key === key);
  if (!isRecord(task)) return undefined;
  const updates: TodoHistory["updates"] = [];
  for (const raw of (Array.isArray(task.updates) ? task.updates : []).slice(-MAX_UPDATES)) {
    if (!isRecord(raw) || !STATUSES.has(raw.status)) continue;
    const at = time(raw.at);
    if (!at) continue;
    const message = clip(raw.message, MAX_MESSAGE);
    updates.push({
      revision: count(raw.revision) ?? 0, at, status: raw.status as TodoStatus,
      ...(STATUSES.has(raw.from) ? { from: raw.from as TodoStatus } : {}),
      ...(message ? { message } : {}),
      ...(raw.by === "user" ? { byUser: true } : {}),
    });
  }
  const createdAt = time(task.createdAt);
  return { key, ...(createdAt ? { createdAt } : {}), updates };
}

/** Validates pi-stash's preview answer before it leaves the process. */
export function readPreview(data: unknown): StashPreview | string {
  if (!isRecord(data)) return "pi-stash did not answer; is it loaded?";
  if (data.ok !== true) return typeof data.error === "string" ? data.error.slice(0, 500) : "Preview failed.";
  if (typeof data.handle !== "string" || !Array.isArray(data.lines)) return "pi-stash sent an unreadable preview.";
  // pi-stash bounds this at 200 lines / 16 KB; keep a hard ceiling here too.
  const lines = data.lines.slice(0, 200).map((line) => typeof line === "string" ? line.slice(0, 2_000) : "");
  return { handle: data.handle, lines, total: count(data.total) ?? lines.length, complete: data.complete === true };
}
