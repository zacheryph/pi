// Pure helpers shared by the slots: labels and numbers.
import type { SessionStatus } from "../contract.ts";

/** Shown for a saved snapshot: no Pi runs for the thread until its next turn. */
export const NOT_RUNNING = "Not running · resumes with the next turn";

export function statusText(status: SessionStatus | undefined): string {
  switch (status?.kind) {
    case undefined:
      return "Connected";
    case "idle":
      return "Idle";
    case "working":
      return "Working";
    case "tool":
      return `Running ${status.tool}`;
    case "compacting":
      return "Compacting";
    case "waiting":
      return status.title ? `Waiting: ${status.title}` : "Waiting for you";
  }
}

/** `42s`, `6m`, `2h 5m`. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

export function ago(at: number, now = Date.now()): string {
  return `${duration(now - at)} ago`;
}

/** `1.2k`, `48k`, `1.9M`. */
export function compact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** `3 agents`, `1 agent`. */
export function plural(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}
