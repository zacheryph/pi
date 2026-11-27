import {
  ICONS,
  renderWidget,
  sanitizeLine,
  sanitizeText,
  stateCounts,
  type Block,
  type Line,
  type Span,
  type UITheme,
  type WidgetModel,
  type WidgetRow,
  type WidgetView,
} from "#ui";
import type { StateIcon } from "#surface";
import type { TodoActivity, TodoUpdate } from "#src/activity";
import { isTaskBlocked, type TodoState, type TodoTask } from "#src/state";

export interface TodoRenderConfig {
  maxVisible: number;
  showCompleted: boolean;
  /** Latest message by task key, shown after the task's identity. */
  messages?: ReadonlyMap<string, string>;
  /** Subagent holding each delegated task, as a display label. */
  assignees?: ReadonlyMap<string, string>;
  /** Header title; defaults to Todos. */
  title?: string;
}

export function todoTaskPresentation(
  task: TodoTask,
  state: TodoState,
): {
  glyph: string;
  label: string;
  color: "success" | "accent" | "warning" | "dim";
} {
  if (task.status === "completed") return { glyph: "✓", label: "completed", color: "success" };
  if (task.status === "in_progress") return { glyph: "▸", label: "in_progress", color: "accent" };
  if (isTaskBlocked(task, state.tasks)) return { glyph: "○", label: "blocked", color: "warning" };
  return { glyph: "○", label: "pending", color: "dim" };
}

/**
 * In progress, pending, blocked, then completed; stable within groups, and
 * never sorts or mutates state itself.
 */
export function orderedTodoTasks(state: TodoState): TodoTask[] {
  const rank = (task: TodoTask) =>
    task.status === "in_progress"
      ? 0
      : task.status === "completed"
        ? 3
        : isTaskBlocked(task, state.tasks)
          ? 2
          : 1;
  return [...state.tasks].sort((a, b) => rank(a) - rank(b));
}

/** One physical, whitespace-collapsed row of untrusted message text. */
export function todoMessageLine(message: string): string {
  return sanitizeLine(message).replace(/\s+/g, " ").trim();
}

function taskLeft(task: TodoTask): string {
  return (
    `${sanitizeLine(task.key)}: ${sanitizeLine(task.subject)}` +
    (task.dependsOn?.length ? ` ← ${task.dependsOn.map(sanitizeLine).join(", ")}` : "")
  );
}

function renderSelection(state: TodoState, config: TodoRenderConfig) {
  return {
    messages: config.messages ?? new Map<string, string>(),
    tasks: orderedTodoTasks(state).filter(
      (task) => config.showCompleted || task.status !== "completed",
    ),
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
  const { tasks, maxVisible, messages } = renderSelection(state, config);
  const done = state.tasks.filter((task) => task.status === "completed").length;
  const lines = [
    `${sanitizeLine(config.title ?? "Todos")} ${done}/${state.tasks.length} completed`,
  ];
  if (!tasks.length) {
    lines.push(state.tasks.length ? "No unfinished tasks" : "No tasks");
    return lines;
  }
  const shown = tasks.slice(0, maxVisible);
  for (const task of shown) {
    const status = todoTaskPresentation(task, state);
    const message = messages.get(task.key);
    const excerpt = message === undefined ? "" : todoMessageLine(message);
    const assignee = config.assignees?.get(task.key);
    lines.push(
      `${status.glyph} ${taskLeft(task)} [${status.label}]` +
        (assignee ? ` → ${sanitizeLine(assignee)}` : "") +
        (task.description ? ` — ${sanitizeLine(task.description)}` : "") +
        (message === undefined
          ? ""
          : ` · last: ${excerpt.length > 160 ? `${excerpt.slice(0, 159)}…` : excerpt}`),
    );
  }
  if (tasks.length > shown.length) lines.push(`+${tasks.length - shown.length} more`);
  return lines;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Local wall-clock time; the date is added only when it differs from now. */
export function formatTodoClock(at: number, now: number): string {
  const date = new Date(at);
  const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return day(date) === day(new Date(now)) ? time : `${day(date)} ${time}`;
}

export function formatTodoAge(at: number, now: number): string {
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

const formatWhen = (at: number, now: number) =>
  `${formatTodoAge(at, now)} (${formatTodoClock(at, now)})`;

function describeUpdate(update: TodoUpdate): string {
  const change = update.from
    ? `${update.from} → ${update.status}`
    : update.message
      ? `note (${update.status})`
      : update.status;
  return (
    `r${update.revision} · ${change}${update.by === "user" ? " · you" : ""}` +
    (update.agent ? ` · agent ${sanitizeLine(update.agent).slice(0, 8)}` : "")
  );
}

export interface TodoDetailHistory {
  activity: TodoActivity;
  now: number;
}

/** Structured detail; optional history adds times and a timeline. */
export function todoTaskDetail(
  task: TodoTask,
  state: TodoState,
  history?: TodoDetailHistory,
  assignee?: string,
): Block[] {
  const byKey = new Map(state.tasks.map((item) => [item.key, item]));
  const entry = history?.activity.get(task.key);
  const updates = entry?.updates ?? [];
  const fields: [string, Line][] = [];
  if (assignee) fields.push(["Assigned to", assignee]);
  if (history) {
    if (entry?.createdAt !== undefined)
      fields.push(["Created", formatWhen(entry.createdAt, history.now)]);
    if (updates.length) fields.push(["Updated", formatWhen(updates.at(-1)!.at, history.now)]);
  }
  if (!task.dependsOn?.length) fields.push(["Dependencies", "none"]);
  const blocks: Block[] = fields.length ? [{ fields }] : [];
  if (task.dependsOn?.length)
    blocks.push(
      { heading: "Dependencies" },
      { bullets: task.dependsOn.map((key) => `${key} — ${byKey.get(key)?.status ?? "missing"}`) },
    );
  blocks.push({ heading: "Description" }, { text: task.description ?? "(none)" });
  if (history && updates.length) {
    blocks.push({ heading: "Activity (newest first)" });
    for (const update of updates.toReversed()) {
      blocks.push({ text: `${formatWhen(update.at, history.now)} · ${describeUpdate(update)}` });
      if (update.message)
        blocks.push({
          lines: sanitizeText(update.message)
            .split("\n")
            .map((line) => `    ${line}`),
        });
    }
  }
  return blocks;
}

/**
 * Status on the right in fallback order: assignee badge drops first, then the
 * status label; the glyph always stays (`keepRight`).
 */
const TASK_ICONS: Record<string, StateIcon> = {
  completed: "done",
  in_progress: "active",
  blocked: "blocked",
  pending: "pending",
};

function statusFallbacks(task: TodoTask, state: TodoState, assignee?: string): Line[] {
  const status = todoTaskPresentation(task, state);
  const badge: Span[] = assignee ? [{ text: `→ ${assignee} · `, tone: "muted" }] : [];
  // The glyph says which state it stands for, so a surface with icons can draw its own.
  const glyph: Span = { text: status.glyph, tone: status.color, icon: TASK_ICONS[status.label] };
  const full: Span[] = [glyph, { text: ` ${status.label}`, tone: status.color }];
  return [
    ...(assignee
      ? [
          [...badge, ...full],
          [...badge, glyph],
        ]
      : []),
    full,
    [glyph],
  ];
}

/**
 * The widget as plain JSON, for any renderer: the `todo.widget` view and,
 * with the terminal's row budgets added, the widget above the editor. Every
 * selected task is a row; the terminal applies `config.maxVisible`.
 */
export function todoWidgetModel(state: TodoState, config: TodoRenderConfig): WidgetModel {
  const { tasks, messages } = renderSelection(state, config);
  const active = state.tasks.filter((task) => task.status === "in_progress").length;
  const counts = stateCounts({
    active,
    pending: state.tasks.filter((task) => task.status === "pending").length,
  });
  const rows: WidgetRow[] = tasks.map((task) => {
    const message = messages.get(task.key);
    const left: Span[] = [];
    // The key is always bold, as a subagent's name is.
    const tone = task.status === "completed" ? "muted" : "default";
    left.push(
      { text: sanitizeLine(task.key), tone, bold: true },
      { text: taskLeft(task).slice(sanitizeLine(task.key).length), tone },
    );
    if (message !== undefined) left.push({ text: ` — ${todoMessageLine(message)}`, tone: "dim" });
    return {
      left,
      right: statusFallbacks(task, state, config.assignees?.get(task.key)),
      keepRight: true,
    };
  });
  return {
    title: { label: config.title ?? "Todos", icon: ICONS.tasks },
    active: active > 0,
    meta: counts ? [counts] : [],
    rows,
    emptyText: state.tasks.length ? "No unfinished tasks" : "No tasks",
  };
}

/** The terminal widget: the JSON model plus row budgets. Selection, order and limits stay todo-owned. */
export function todoWidgetView(
  state: TodoState,
  config: TodoRenderConfig,
  maxRows = Infinity,
): WidgetView {
  const { maxVisible } = renderSelection(state, config);
  return { ...todoWidgetModel(state, config), maxRows, maxVisible };
}

/**
 * Pure widget/tool summary; never reads terminal dimensions. Caller owns widget
 * task/height limits. Expanded tools can request every task. Invalid maxVisible
 * defaults to 5; finite values floor to at least 1. Optional maxRows explicitly
 * bounds rows, reserving overflow space; no height limit applies by default.
 */
export function renderTodoLines(
  state: TodoState,
  config: TodoRenderConfig,
  width: number,
  theme: UITheme,
  maxRows = Infinity,
): string[] {
  return renderWidget(todoWidgetView(state, config, maxRows), width, theme);
}
