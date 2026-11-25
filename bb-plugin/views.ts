// Reading a session's structured views: the core session, extension summaries
// and open forms. Shared by the server (sessions list, questions) and the
// slots. Every value comes from a model's machine-readable fields, never from
// display text, and every reader tolerates a missing or failed view.
import { formatSummaryCount } from "pi-surface/format";
import type {
  DeliverySnapshot,
  ExplorerModel,
  FormQuestionnaire,
  SessionModel,
  SummaryModel,
  ViewEntry,
  WidgetModel,
} from "./contract.ts";

/** The views the slots read by id, as their producers name them. */
export const VIEW = {
  session: "system.session",
  form: "ask.questions",
  todoSummary: "todo.summary",
  subagentSummary: "subagent.summary",
  stashSummary: "stash.summary",
  stashExplorer: "stash.explorer",
  gitSummary: "git.summary",
  gitWorktrees: "git.worktrees",
  gitPrs: "git.prs",
} as const;

type Models = {
  widget: WidgetModel;
  explorer: ExplorerModel;
  session: SessionModel;
  summary: SummaryModel;
};

/** A view's model when the snapshot has it as `kind` and it did not fail. */
export function viewModel<Kind extends keyof Models>(
  snapshot: DeliverySnapshot | null | undefined,
  id: string,
  kind: Kind,
): Models[Kind] | undefined {
  const view = snapshot?.views.find((candidate) => candidate.id === id);
  return view?.kind === kind && view.model !== undefined ? (view.model as Models[Kind]) : undefined;
}

/** The core session: `system.session`, or else the first session view. */
export function sessionModel(
  snapshot: DeliverySnapshot | null | undefined,
): SessionModel | undefined {
  const views = snapshot?.views ?? [];
  const own = viewModel(snapshot, VIEW.session, "session");
  if (own) return own;
  const other = views.find(
    (view): view is Extract<ViewEntry, { kind: "session" }> =>
      view.kind === "session" && view.model !== undefined,
  );
  return other?.model;
}

export function summaryModel(
  snapshot: DeliverySnapshot | null | undefined,
  id: string,
): SummaryModel | undefined {
  return viewModel(snapshot, id, "summary");
}

/** A count's value, or `undefined` when the summary has no such count. */
export function count(summary: SummaryModel | undefined, key: string): number | undefined {
  return summary?.counts.find((candidate) => candidate.key === key)?.value;
}

/**
 * A count as display text, its value then its producer's label (`1 entry`,
 * `25.3 KiB on this branch`), or `undefined` when the summary has no such count.
 */
export function countText(summary: SummaryModel | undefined, key: string): string | undefined {
  const found = summary?.counts.find((candidate) => candidate.key === key);
  return found ? formatSummaryCount(found) : undefined;
}

/** An open questionnaire with the form view that holds it. */
export interface OpenQuestionnaire {
  view: string;
  questionnaire: FormQuestionnaire;
}

/** Every questionnaire open in the snapshot's form views, in view order, oldest first. */
export function openQuestionnaires(
  snapshot: DeliverySnapshot | null | undefined,
): OpenQuestionnaire[] {
  return (snapshot?.views ?? []).flatMap((view) =>
    view.kind === "form" && view.model
      ? view.model.questionnaires.map((questionnaire) => ({ view: view.id, questionnaire }))
      : [],
  );
}

export interface TodoProgress {
  done: number;
  total: number;
  /** The task in progress, by its subject. */
  active?: string;
}

/** Task progress from `todo.summary`, while the plan has tasks. */
export function todoProgress(
  snapshot: DeliverySnapshot | null | undefined,
): TodoProgress | undefined {
  const summary = summaryModel(snapshot, VIEW.todoSummary);
  const total = count(summary, "total") ?? 0;
  if (!summary || total === 0) return undefined;
  return {
    done: count(summary, "completed") ?? 0,
    total,
    ...(summary.active ? { active: summary.active.label } : {}),
  };
}

/** Subagents running or queued, from `subagent.summary`; 0 once settled. */
export function runningAgents(snapshot: DeliverySnapshot | null | undefined): number {
  const summary = summaryModel(snapshot, VIEW.subagentSummary);
  return (count(summary, "running") ?? 0) + (count(summary, "queued") ?? 0);
}

/** The main agent's profile from `subagent.summary`, by its display name. */
export function profileName(snapshot: DeliverySnapshot | null | undefined): string | undefined {
  const profile = summaryModel(snapshot, VIEW.subagentSummary)?.profile;
  return profile ? profile.label || profile.name : undefined;
}

/** Stash entries on the branch, from `stash.summary`. */
export function stashEntries(snapshot: DeliverySnapshot | null | undefined): number {
  return count(summaryModel(snapshot, VIEW.stashSummary), "entries") ?? 0;
}
