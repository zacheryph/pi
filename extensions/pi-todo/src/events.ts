/*
 * Actions and views on this session's bus (see pi-surface), defined from
 * session start to shutdown.
 */

/**
 * Action: `{ id: <key>, reviewed? }` resolves to the task's detail blocks, as
 * `/todo` shows them. `reviewed` (key → `{ revision, at }`) is the review state
 * a list showed; without it the current review state is used.
 */
export const TODO_INSPECT_ACTION = "todo.inspect";
/**
 * Action: mark task messages reviewed; resolves to `{ reviewed: <tasks advanced> }`.
 * `{ ids?, revisions?, branch? }`: with `revisions` (key → revision a list
 * showed), marks those of `ids` (default: all of them) up to that revision;
 * without, marks the latest message of `ids` (default: every task). A `branch`
 * other than the current one is refused, so a stale list cannot mark a
 * different branch.
 */
export const TODO_REVIEW_ACTION = "todo.review";
/** Widget view: the task widget above the editor, absent when the terminal hides it. */
export const TODO_WIDGET_VIEW = "todo.widget";
/** Explorer view: the `/todo` browser on its All tab. */
export const TODO_EXPLORER_VIEW = "todo.explorer";
/**
 * Summary view: this branch's task counts and the task in progress, defined
 * while pi-todo is loaded whether or not the widget shows (see `todoSummaryModel`).
 */
export const TODO_SUMMARY_VIEW = "todo.summary";
