import {
  ICONS,
  renderWidget,
  sanitizeLine,
  sanitizeText,
  type Block,
  type Line,
  type Span,
  type UITheme,
  type WidgetRow,
  type WidgetView,
} from "../../../../packages/pi-ui/src/index.ts";
import {
  isReviewable,
  type TodoActivity,
  type TodoReviewState,
  type TodoUpdate,
  unreviewedTodoUpdates,
} from "../activity.js";
import { isTaskBlocked, type TodoState, type TodoTask } from "../state.js";

export interface TodoRenderConfig {
  maxVisible: number;
  showCompleted: boolean;
  /** Latest unreviewed model message by task key, newest first. */
  unreviewed?: ReadonlyMap<string, string>;
  /** Subagent holding each delegated task, as a display label. */
  assignees?: ReadonlyMap<string, string>;
  /** Header title; defaults to Todos. */
  title?: string;
}

/** Unreviewed rows: `●` in a two-column gutter, plus a one-line excerpt. */
const UNREVIEWED_MARK = ICONS.marker;

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
 * Stable within groups; never sorts/mutates state itself. Optional unreviewed
 * keys (newest first) rank ahead of every status group, in that order.
 */
export function orderedTodoTasks(
  state: TodoState,
  unreviewed?: ReadonlyMap<string, unknown>,
): TodoTask[] {
  const flagged = [...(unreviewed?.keys() ?? [])];
  const rank = (task: TodoTask) => {
    const index = flagged.indexOf(task.key);
    if (index >= 0) return index - flagged.length;
    return task.status === "in_progress"
      ? 0
      : task.status === "completed"
        ? 3
        : isTaskBlocked(task, state.tasks)
          ? 2
          : 1;
  };
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
  const unreviewed = config.unreviewed ?? new Map<string, string>();
  return {
    unreviewed,
    // Hiding completed tasks never hides an unreviewed outcome.
    tasks: orderedTodoTasks(state, unreviewed).filter(
      (task) => config.showCompleted || task.status !== "completed" || unreviewed.has(task.key),
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
  const { tasks, maxVisible, unreviewed } = renderSelection(state, config);
  const done = state.tasks.filter((task) => task.status === "completed").length;
  const lines = [
    `${sanitizeLine(config.title ?? "Todos")} ${done}/${state.tasks.length} completed${unreviewed.size ? ` · ${unreviewed.size} new` : ""}`,
  ];
  if (!tasks.length) {
    lines.push(state.tasks.length ? "No unfinished tasks" : "No tasks");
    return lines;
  }
  const shown = tasks.slice(0, maxVisible);
  for (const task of shown) {
    const status = todoTaskPresentation(task, state);
    const message = unreviewed.get(task.key);
    const excerpt = message === undefined ? "" : todoMessageLine(message);
    const assignee = config.assignees?.get(task.key);
    lines.push(
      `${message === undefined ? "" : `${UNREVIEWED_MARK} `}${status.glyph} ${taskLeft(task)} [${status.label}]` +
        (assignee ? ` → ${sanitizeLine(assignee)}` : "") +
        (task.description ? ` — ${sanitizeLine(task.description)}` : "") +
        (message === undefined
          ? ""
          : ` · new: ${excerpt.length > 160 ? `${excerpt.slice(0, 159)}…` : excerpt}`),
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
  review: TodoReviewState;
  now: number;
}

/** Structured detail; optional history adds times, review state and a timeline. */
export function todoTaskDetail(
  task: TodoTask,
  state: TodoState,
  history?: TodoDetailHistory,
  assignee?: string,
): Block[] {
  const byKey = new Map(state.tasks.map((item) => [item.key, item]));
  const entry = history?.activity.get(task.key);
  const updates = entry?.updates ?? [];
  const reviewed = history?.review.tasks.get(task.key);
  const unreviewed = new Set(
    history ? unreviewedTodoUpdates(task.key, history.activity, history.review) : [],
  );
  const fields: [string, Line][] = [];
  if (assignee) fields.push(["Assigned to", assignee]);
  if (history) {
    if (entry?.createdAt !== undefined)
      fields.push(["Created", formatWhen(entry.createdAt, history.now)]);
    if (updates.length) fields.push(["Updated", formatWhen(updates.at(-1)!.at, history.now)]);
    if (updates.some(isReviewable))
      fields.push([
        "Reviewed",
        reviewed
          ? `${formatWhen(reviewed.at, history.now)} through r${reviewed.revision}`
          : { text: "never", tone: "warning" },
      ]);
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
    blocks.push({
      heading: `Activity (newest first${unreviewed.size ? `; ${UNREVIEWED_MARK} = unreviewed` : ""})`,
    });
    for (const update of updates.toReversed()) {
      const fresh = unreviewed.has(update);
      blocks.push({
        text: `${fresh ? UNREVIEWED_MARK : " "} ${formatWhen(update.at, history.now)} · ${describeUpdate(update)}`,
        tone: fresh ? "accent" : "default",
      });
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
function statusFallbacks(task: TodoTask, state: TodoState, assignee?: string): Line[] {
  const status = todoTaskPresentation(task, state);
  const badge: Span[] = assignee ? [{ text: `→ ${assignee} · `, tone: "muted" }] : [];
  const glyph: Span = { text: status.glyph, tone: status.color };
  const full: Span = { text: `${status.glyph} ${status.label}`, tone: status.color };
  return [
    ...(assignee
      ? [
          [...badge, full],
          [...badge, glyph],
        ]
      : []),
    [full],
    [glyph],
  ];
}

/** Shared widget description; selection, ordering and limits stay todo-owned. */
export function todoWidgetView(
  state: TodoState,
  config: TodoRenderConfig,
  maxRows = Infinity,
): WidgetView {
  const { tasks, maxVisible, unreviewed } = renderSelection(state, config);
  const done = state.tasks.filter((task) => task.status === "completed").length;
  const progress: Span = {
    text: `${done}/${state.tasks.length}`,
    tone: done === state.tasks.length && done > 0 ? "success" : "muted",
  };
  // Narrow terminals drop the unreviewed count before progress; rows keep markers.
  const meta: Line[] = [
    ...(unreviewed.size
      ? [
          [
            { text: `${UNREVIEWED_MARK} ${unreviewed.size} new`, tone: "accent" as const },
            { text: " · ", tone: "dim" as const },
            progress,
          ],
        ]
      : []),
    [progress],
  ];
  // Only reserve a marker gutter when a visible row needs it.
  const gutter = tasks.slice(0, maxVisible).some((task) => unreviewed.has(task.key));
  const rows: WidgetRow[] = tasks.map((task) => {
    const message = unreviewed.get(task.key);
    const left: Span[] = [];
    if (gutter)
      left.push(message === undefined ? "  " : { text: `${UNREVIEWED_MARK} `, tone: "accent" });
    left.push({
      text: taskLeft(task),
      tone: task.status === "completed" && message === undefined ? "muted" : "default",
    });
    if (message !== undefined) left.push({ text: ` — ${todoMessageLine(message)}`, tone: "dim" });
    return {
      left,
      right: statusFallbacks(task, state, config.assignees?.get(task.key)),
      keepRight: true,
    };
  });
  return {
    title: { label: config.title ?? "Todos", icon: ICONS.tasks },
    active: state.tasks.some((task) => task.status === "in_progress"),
    meta,
    rows,
    maxRows,
    maxVisible,
    emptyText: state.tasks.length ? "No unfinished tasks" : "No tasks",
  };
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
  theme: UITheme,
  maxRows = Infinity,
): string[] {
  return renderWidget(todoWidgetView(state, config, maxRows), width, theme);
}
