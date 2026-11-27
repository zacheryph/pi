/*
 * Actions and views on this session's bus (see pi-surface), defined from
 * session start to shutdown.
 */

/** Action: `{ id: <key> }` resolves to the task's detail blocks, as `/todo` shows them. */
export const TODO_INSPECT_ACTION = "todo.inspect";
/** Widget view: the task widget above the editor, absent when the terminal hides it. */
export const TODO_WIDGET_VIEW = "todo.widget";
/** Explorer view: the `/todo` browser on its All tab. */
export const TODO_EXPLORER_VIEW = "todo.explorer";
/**
 * Summary view: this branch's task counts and the task in progress, defined
 * while pi-todo is loaded whether or not the widget shows (see `todoSummaryModel`).
 */
export const TODO_SUMMARY_VIEW = "todo.summary";
/** Attention view: one item per task waiting on the user, each answered by `todo.unblock`. */
export const TODO_ATTENTION_VIEW = "todo.attention";
/**
 * Action: `{ key, rev, text }` answers a task waiting on the user. It records the text on the
 * task as the user's, sets it pending and wakes the session with the answer.
 */
export const TODO_UNBLOCK_ACTION = "todo.unblock";
