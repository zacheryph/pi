import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isTaskBlocked, type TodoState, type TodoTask } from "../state.js";
import { safeTodoLine, sanitizeTodoText } from "./text.js";

/** nf-fa-tasks (U+F0AE); themed titles require a patched Nerd Font. */
const TODO_TITLE = "  Todos";

export interface TodoRenderConfig {
  maxVisible: number;
  showCompleted: boolean;
}

export function todoTaskPresentation(task: TodoTask, state: TodoState): {
  glyph: string; label: string; color: "success" | "accent" | "warning" | "dim";
} {
  if (task.status === "completed") return { glyph: "✓", label: "completed", color: "success" };
  if (task.status === "in_progress") return { glyph: "▸", label: "in_progress", color: "accent" };
  if (isTaskBlocked(task, state.tasks)) return { glyph: "○", label: "blocked", color: "warning" };
  return { glyph: "○", label: "pending", color: "dim" };
}

/** Stable within groups; never sorts/mutates state itself. */
export function orderedTodoTasks(state: TodoState): TodoTask[] {
  const rank = (task: TodoTask) => task.status === "in_progress" ? 0
    : task.status === "completed" ? 3 : isTaskBlocked(task, state.tasks) ? 2 : 1;
  return [...state.tasks].sort((a, b) => rank(a) - rank(b));
}

function taskLeft(task: TodoTask): string {
  return `${safeTodoLine(task.key)}: ${safeTodoLine(task.subject)}`
    + (task.dependsOn?.length ? ` ← ${task.dependsOn.map(safeTodoLine).join(", ")}` : "");
}

function renderSelection(state: TodoState, config: TodoRenderConfig) {
  return {
    tasks: orderedTodoTasks(state).filter(task => config.showCompleted || task.status !== "completed"),
    maxVisible: Number.isFinite(config.maxVisible) ? Math.max(1, Math.floor(config.maxVisible)) : 5,
  };
}

/**
 * Safe plain-text summary, one physical row per task including description.
 * Config uses the same priority/filter/overflow as themed rendering. Omitting
 * config preserves the full snapshot, including completed tasks.
 */
export function renderTodoText(
  state: TodoState,
  config: TodoRenderConfig = { maxVisible: state.tasks.length, showCompleted: true },
): string[] {
  const { tasks, maxVisible } = renderSelection(state, config);
  const done = state.tasks.filter(task => task.status === "completed").length;
  const lines = [`Todos ${done}/${state.tasks.length} completed`];
  if (!tasks.length) {
    lines.push(state.tasks.length ? "No unfinished tasks" : "No tasks");
    return lines;
  }
  const shown = tasks.slice(0, maxVisible);
  for (const task of shown) {
    const status = todoTaskPresentation(task, state);
    lines.push(`${status.glyph} ${taskLeft(task)} [${status.label}]`
      + (task.description ? ` — ${safeTodoLine(task.description)}` : ""));
  }
  if (tasks.length > shown.length) lines.push(`+${tasks.length - shown.length} more`);
  return lines;
}

export function todoTaskDetail(task: TodoTask, state: TodoState): string[] {
  const byKey = new Map(state.tasks.map(item => [item.key, item]));
  const status = todoTaskPresentation(task, state);
  return [
    `Key: ${safeTodoLine(task.key)}`,
    `Subject: ${safeTodoLine(task.subject)}`,
    `Status: ${status.glyph} ${status.label}`,
    `Dependencies: ${task.dependsOn?.length ? "" : "none"}`,
    ...(task.dependsOn ?? []).map(key => {
      const dependency = byKey.get(key);
      return `  ${safeTodoLine(key)} — ${dependency?.status ?? "missing"}`;
    }),
    "", "Description:", sanitizeTodoText(task.description ?? "(none)"),
  ];
}

/** One physical row per task. Status retains its columns; key clips last. */
function taskRow(task: TodoTask, state: TodoState, width: number, theme: Theme): string {
  const status = todoTaskPresentation(task, state);
  const fullRight = `${status.glyph} ${status.label}`;
  const keyWidth = visibleWidth(safeTodoLine(task.key));
  const right = width >= keyWidth + visibleWidth(fullRight) + 3 ? fullRight : status.glyph;
  if (width < 3) return theme.fg(status.color, truncateToWidth(status.glyph, width, ""));
  const rightWidth = visibleWidth(right);
  const left = truncateToWidth(taskLeft(task), width - rightWidth - 1, "");
  return theme.fg(task.status === "completed" ? "muted" : "text", left)
    + " ".repeat(Math.max(1, width - visibleWidth(left) - rightWidth))
    + theme.fg(status.color, right);
}

/**
 * Pure widget/tool summary; never reads terminal dimensions. Caller owns widget
 * task/height limits. Expanded tools can request all 50 tasks. Invalid maxVisible
 * defaults to 5; finite values floor to at least 1. Optional maxRows explicitly
 * bounds rows, reserving overflow space; no height limit applies by default.
 */
export function renderTodoLines(
  state: TodoState,
  config: TodoRenderConfig,
  width: number,
  theme: Theme,
  maxRows = Infinity,
): string[] {
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const rows = maxRows === Infinity ? Infinity : Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : 0;
  if (!width || !rows) return [];
  const { tasks, maxVisible } = renderSelection(state, config);
  const done = state.tasks.filter(task => task.status === "completed").length;
  const progress = `${done}/${state.tasks.length}`;
  const label = `── ${TODO_TITLE} `;
  const labelColor = state.tasks.some(task => task.status === "in_progress") ? "accent" : "dim";
  const top = width >= visibleWidth(label) + visibleWidth(progress) + 1
    ? theme.fg("border", "── ") + theme.fg(labelColor, TODO_TITLE)
      + theme.fg("border", " " + "─".repeat(width - visibleWidth(label) - visibleWidth(progress) - 1) + " ")
      + theme.fg(done === state.tasks.length && done > 0 ? "success" : "muted", progress)
    : theme.fg(labelColor, truncateToWidth(TODO_TITLE, width, ""));
  // Inset body rows from full-width chrome, including after narrow resizes.
  const bodyWidth = Math.max(0, width - 2);
  const bodyRow = (text: string) => width <= 2 ? " ".repeat(width)
    : ` ${truncateToWidth(text, bodyWidth, "")} `;
  const lines = [top];
  if (!tasks.length && rows > 1) {
    lines.push(bodyRow(theme.fg("muted", state.tasks.length ? "No unfinished tasks" : "No tasks")));
    return lines;
  }
  // Reserve overflow row only when needed. Hidden completed tasks don't count.
  const available = Math.max(0, rows - 1);
  const count = Math.min(tasks.length, maxVisible, available);
  const visible = tasks.length > count ? Math.max(0, Math.min(count, available - 1)) : count;
  for (const task of tasks.slice(0, visible)) lines.push(bodyRow(taskRow(task, state, bodyWidth, theme)));
  if (tasks.length > visible && lines.length < rows) {
    lines.push(bodyRow(theme.fg("dim", `+${tasks.length - visible} more`)));
  }
  return lines;
}
