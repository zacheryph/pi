// Pure helpers shared by the slots: counts, labels and bb icon names.
import type { SessionSnapshot, SubagentState, TodoSection, TodoStatus } from "../contract.ts";

type Task = TodoSection["tasks"][number];

export interface TodoCounts {
  done: number;
  total: number;
  active?: Task;
}

export function todoCounts(todos: TodoSection | undefined): TodoCounts | undefined {
  if (!todos || todos.total === 0) return undefined;
  const active = todos.tasks.find((task) => task.status === "in_progress");
  return {
    done: todos.tasks.filter((task) => task.status === "completed").length,
    total: todos.total,
    ...(active ? { active } : {}),
  };
}

/** bb icon for a task row; blocked pending tasks show a lock. */
export function taskIcon(status: TodoStatus, blocked = false): string {
  if (status === "completed") return "CircleCheck";
  if (status === "in_progress") return "Loading";
  return blocked ? "Lock" : "Circle";
}

export function taskLabel(status: TodoStatus, blocked = false): string {
  if (status === "completed") return "Done";
  if (status === "in_progress") return "In progress";
  return blocked ? "Blocked" : "Pending";
}

const RUNNING: ReadonlySet<SubagentState> = new Set(["queued", "running"]);

export function isRunning(state: SubagentState): boolean {
  return RUNNING.has(state);
}

export function runningAgents(snapshot: SessionSnapshot | null | undefined): number {
  return snapshot?.subagents?.agents.filter((agent) => isRunning(agent.state)).length ?? 0;
}

export function agentIcon(state: SubagentState): string {
  switch (state) {
    case "queued":
      return "Clock";
    case "running":
      return "Loading";
    case "waiting":
      return "Pause";
    case "completed":
      return "CircleCheck";
    case "failed":
      return "CircleX";
    case "stopped":
      return "X";
  }
}

export function statusText(snapshot: SessionSnapshot): string {
  const { status } = snapshot;
  switch (status.kind) {
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

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** `#212` from `owner/repo#212`. */
export function prNumber(label: string): string {
  const hash = label.lastIndexOf("#");
  return hash >= 0 ? label.slice(hash) : label;
}
