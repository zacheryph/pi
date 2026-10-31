import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  isReviewable, type TodoActivity, type TodoReviewState, type TodoUpdate, unreviewedTodoUpdates,
} from "../activity.js";
import { isTaskBlocked, type TodoState, type TodoTask } from "../state.js";
import { safeTodoLine, sanitizeTodoText } from "./text.js";

/** nf-fa-tasks (U+F0AE); themed titles require a patched Nerd Font. */
const TODO_TITLE = "  Todos";

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
const UNREVIEWED_MARK = "●";

export function todoTaskPresentation(task: TodoTask, state: TodoState): {
  glyph: string; label: string; color: "success" | "accent" | "warning" | "dim";
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
export function orderedTodoTasks(state: TodoState, unreviewed?: ReadonlyMap<string, unknown>): TodoTask[] {
  const flagged = [...(unreviewed?.keys() ?? [])];
  const rank = (task: TodoTask) => {
    const index = flagged.indexOf(task.key);
    if (index >= 0) return index - flagged.length;
    return task.status === "in_progress" ? 0
      : task.status === "completed" ? 3 : isTaskBlocked(task, state.tasks) ? 2 : 1;
  };
  return [...state.tasks].sort((a, b) => rank(a) - rank(b));
}

/** One physical, whitespace-collapsed row of untrusted message text. */
export function todoMessageLine(message: string): string {
  return safeTodoLine(message).replace(/\s+/g, " ").trim();
}

function taskLeft(task: TodoTask): string {
  return `${safeTodoLine(task.key)}: ${safeTodoLine(task.subject)}`
    + (task.dependsOn?.length ? ` ← ${task.dependsOn.map(safeTodoLine).join(", ")}` : "");
}

function renderSelection(state: TodoState, config: TodoRenderConfig) {
  const unreviewed = config.unreviewed ?? new Map<string, string>();
  return {
    unreviewed,
    // Hiding completed tasks never hides an unreviewed outcome.
    tasks: orderedTodoTasks(state, unreviewed)
      .filter(task => config.showCompleted || task.status !== "completed" || unreviewed.has(task.key)),
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
  const done = state.tasks.filter(task => task.status === "completed").length;
  const lines = [`${safeTodoLine(config.title ?? "Todos")} ${done}/${state.tasks.length} completed${unreviewed.size ? ` · ${unreviewed.size} new` : ""}`];
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
    lines.push(`${message === undefined ? "" : `${UNREVIEWED_MARK} `}${status.glyph} ${taskLeft(task)} [${status.label}]`
      + (assignee ? ` → ${safeTodoLine(assignee)}` : "")
      + (task.description ? ` — ${safeTodoLine(task.description)}` : "")
      + (message === undefined ? "" : ` · new: ${excerpt.length > 160 ? `${excerpt.slice(0, 159)}…` : excerpt}`));
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

const formatWhen = (at: number, now: number) => `${formatTodoAge(at, now)} (${formatTodoClock(at, now)})`;

function describeUpdate(update: TodoUpdate): string {
  const change = update.from ? `${update.from} → ${update.status}`
    : update.message ? `note (${update.status})` : update.status;
  return `r${update.revision} · ${change}${update.by === "user" ? " · you" : ""}`
    + (update.agent ? ` · agent ${safeTodoLine(update.agent).slice(0, 8)}` : "");
}

export interface TodoDetailHistory {
  activity: TodoActivity;
  review: TodoReviewState;
  now: number;
}

/** Plain detail text; optional history adds times, review state and a timeline. */
export function todoTaskDetail(task: TodoTask, state: TodoState, history?: TodoDetailHistory, assignee?: string): string[] {
  const byKey = new Map(state.tasks.map(item => [item.key, item]));
  const status = todoTaskPresentation(task, state);
  const entry = history?.activity.get(task.key);
  const updates = entry?.updates ?? [];
  const reviewed = history?.review.tasks.get(task.key);
  const unreviewed = new Set(history ? unreviewedTodoUpdates(task.key, history.activity, history.review) : []);
  const times = history ? [
    ...(entry?.createdAt !== undefined ? [`Created: ${formatWhen(entry.createdAt, history.now)}`] : []),
    ...(updates.length ? [`Updated: ${formatWhen(updates.at(-1)!.at, history.now)}`] : []),
    ...(updates.some(isReviewable)
      ? [`Reviewed: ${reviewed ? `${formatWhen(reviewed.at, history.now)} through r${reviewed.revision}` : "never"}`]
      : []),
  ] : [];
  return [
    `Key: ${safeTodoLine(task.key)}`,
    `Subject: ${safeTodoLine(task.subject)}`,
    `Status: ${status.glyph} ${status.label}`,
    ...(assignee ? [`Assigned to: ${safeTodoLine(assignee)}`] : []),
    ...times,
    `Dependencies: ${task.dependsOn?.length ? "" : "none"}`,
    ...(task.dependsOn ?? []).map(key => {
      const dependency = byKey.get(key);
      return `  ${safeTodoLine(key)} — ${dependency?.status ?? "missing"}`;
    }),
    "", "Description:", sanitizeTodoText(task.description ?? "(none)"),
    ...(history && updates.length ? [
      "", `Activity (newest first${unreviewed.size ? `; ${UNREVIEWED_MARK} = unreviewed` : ""}):`,
      ...updates.toReversed().flatMap(update => [
        `${unreviewed.has(update) ? UNREVIEWED_MARK : " "} ${formatWhen(update.at, history.now)} · ${describeUpdate(update)}`,
        ...(update.message ? sanitizeTodoText(update.message).split("\n").map(line => `    ${line}`) : []),
      ]),
    ] : []),
  ];
}

/**
 * One physical row per task. Status retains its columns; key clips last. With a
 * gutter, unreviewed rows show the marker and a dim message excerpt after the
 * identity; other rows keep a blank gutter so columns stay aligned.
 */
function taskRow(
  task: TodoTask, state: TodoState, width: number, theme: Theme, gutter = false, message?: string, assignee?: string,
): string {
  const status = todoTaskPresentation(task, state);
  const keyWidth = visibleWidth(safeTodoLine(task.key)) + (gutter ? 2 : 0);
  // The assignee badge goes first when space runs out; the status glyph stays.
  const badge = assignee ? `→ ${safeTodoLine(assignee)} · ` : "";
  const right = [`${badge}${status.glyph} ${status.label}`, `${badge}${status.glyph}`, `${status.glyph} ${status.label}`]
    .find(candidate => width >= keyWidth + visibleWidth(candidate) + 3) ?? status.glyph;
  if (width < 3) return theme.fg(status.color, truncateToWidth(status.glyph, width, ""));
  const rightWidth = visibleWidth(right);
  const shownBadge = badge && right.startsWith(badge) ? badge : "";
  const available = width - rightWidth - 1;
  const marker = gutter && available >= 2 ? message === undefined ? "  " : theme.fg("accent", `${UNREVIEWED_MARK} `) : "";
  const room = available - visibleWidth(marker);
  const left = truncateToWidth(taskLeft(task), room, "");
  const spare = room - visibleWidth(left);
  const excerpt = message !== undefined && spare > 3 ? truncateToWidth(` — ${todoMessageLine(message)}`, spare, "") : "";
  return marker + theme.fg(task.status === "completed" && message === undefined ? "muted" : "text", left)
    + theme.fg("dim", excerpt)
    + " ".repeat(Math.max(1, width - visibleWidth(marker) - visibleWidth(left) - visibleWidth(excerpt) - rightWidth))
    + (shownBadge ? theme.fg("muted", shownBadge) : "")
    + theme.fg(status.color, right.slice(shownBadge.length));
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
  const { tasks, maxVisible, unreviewed } = renderSelection(state, config);
  const done = state.tasks.filter(task => task.status === "completed").length;
  const progress = `${done}/${state.tasks.length}`;
  const title = config.title ? `  ${safeTodoLine(config.title)}` : TODO_TITLE;
  const label = `── ${title} `;
  const tail = " ──";
  const labelColor = state.tasks.some(task => task.status === "in_progress") ? "accent" : "dim";
  const fits = (right: string) => width >= visibleWidth(label) + visibleWidth(right) + 1 + visibleWidth(tail);
  const progressText = theme.fg(done === state.tasks.length && done > 0 ? "success" : "muted", progress);
  // Narrow terminals drop the unreviewed count before progress; rows keep markers.
  const flag = unreviewed.size ? `${UNREVIEWED_MARK} ${unreviewed.size} new` : "";
  const [right, rightText] = flag && fits(`${flag} · ${progress}`)
    ? [`${flag} · ${progress}`, theme.fg("accent", flag) + theme.fg("dim", " · ") + progressText]
    : [progress, progressText];
  const top = fits(right)
    ? theme.fg("border", "── ") + theme.fg(labelColor, title)
      + theme.fg("border", " " + "─".repeat(width - visibleWidth(label) - visibleWidth(right) - 1 - visibleWidth(tail)) + " ")
      + rightText
      + theme.fg("border", tail)
    : theme.fg(labelColor, truncateToWidth(title, width, ""));
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
  const shown = tasks.slice(0, visible);
  const gutter = shown.some(task => unreviewed.has(task.key));
  for (const task of shown) {
    lines.push(bodyRow(taskRow(task, state, bodyWidth, theme, gutter, unreviewed.get(task.key), config.assignees?.get(task.key))));
  }
  if (tasks.length > visible && lines.length < rows) {
    lines.push(bodyRow(theme.fg("dim", `+${tasks.length - visible} more`)));
  }
  return lines;
}
