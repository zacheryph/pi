import type { SessionActivity } from "#surface";
import { toolLabel } from "#src/session/status";
import { clip } from "#src/session/text";

/** Most recent calls the session view lists. */
export const MAX_ACTIVITY = 12;
const MAX_SUMMARY = 80;
/** Tools whose path argument says what they touch. */
const PATH_ARGS = ["path", "file_path", "filePath"];

/** A call; a running one has no duration or error yet. */
type Entry = {
  id: string;
  tool: string;
  summary?: string;
  at: number;
  running?: true;
  durationMs?: number;
  error?: true;
};

/** What a call is about, without its content: a path, or a bash command's first line. */
export function summarize(tool: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const raw = args as Record<string, unknown>;
  if (tool === "bash") {
    const command = typeof raw.command === "string" ? raw.command.trim().split("\n")[0] : undefined;
    return clip(command, MAX_SUMMARY);
  }
  for (const key of PATH_ARGS) {
    const path = clip(raw[key], 200);
    // Keep the end of long paths, where the file name is.
    if (path) return path.length > MAX_SUMMARY ? `…${path.slice(-(MAX_SUMMARY - 1))}` : path;
  }
  return undefined;
}

/**
 * The latest top-level tool calls this process saw, newest first. Process-bound:
 * a new tracker is empty, and nothing is read back from history, so a restored
 * session never shows a call as running.
 */
export class ActivityTracker {
  private entries: Entry[] = [];
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  start(id: string, tool: string, args: unknown): void {
    const summary = summarize(tool, args);
    const started: Entry = {
      id,
      tool: toolLabel(tool),
      ...(summary ? { summary } : {}),
      at: this.now(),
      running: true,
    };
    const others = this.entries.filter((entry) => entry.id !== id);
    this.entries = [started, ...others].slice(0, MAX_ACTIVITY);
  }

  end(id: string, isError: boolean): void {
    const index = this.entries.findIndex((candidate) => candidate.id === id);
    const entry = this.entries[index];
    if (!entry?.running) return;
    const { running: _running, ...rest } = entry;
    this.entries[index] = {
      ...rest,
      durationMs: Math.max(0, this.now() - entry.at),
      ...(isError ? { error: true } : {}),
    };
  }

  /** Pi has settled: a call still running was interrupted, and has no duration. */
  settle(): void {
    this.entries = this.entries.map((entry) => {
      if (!entry.running) return entry;
      const { running: _running, ...rest } = entry;
      return rest;
    });
  }

  /** The calls as the session view lists them; a running call is marked `live`. */
  list(): SessionActivity[] | undefined {
    if (!this.entries.length) return undefined;
    return this.entries.map(({ id: _id, running, ...entry }) =>
      running ? { ...entry, live: true } : { ...entry },
    );
  }
}
