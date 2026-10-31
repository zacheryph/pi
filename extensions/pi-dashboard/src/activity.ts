import type { ActivitySection } from "./protocol.ts";
import { clip } from "./sections.ts";

const MAX_ENTRIES = 12;
const MAX_SUMMARY = 80;
/** Tools whose path argument says what they touch. */
const PATH_ARGS = ["path", "file_path", "filePath"];

type Entry = ActivitySection[number] & { id: string };

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

/** The latest top-level tool calls, for the detail page's activity list. */
export class ActivityTracker {
  private entries: Entry[] = [];
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  start(id: string, tool: string, args: unknown): void {
    const summary = summarize(tool, args);
    this.entries = [
      {
        id,
        tool: clip(tool, 64) ?? "tool",
        ...(summary ? { summary } : {}),
        at: this.now(),
        running: true,
      },
      ...this.entries.filter((entry) => entry.id !== id),
    ].slice(0, MAX_ENTRIES);
  }

  end(id: string, isError: boolean): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return;
    delete entry.running;
    entry.durationMs = Math.max(0, this.now() - entry.at);
    if (isError) entry.error = true;
  }

  /** Pi has settled: anything still marked running was interrupted. */
  settle(): void {
    for (const entry of this.entries) delete entry.running;
  }

  section(): ActivitySection | undefined {
    return this.entries.length
      ? this.entries.map(({ id: _id, ...entry }) => ({ ...entry }))
      : undefined;
  }
}
