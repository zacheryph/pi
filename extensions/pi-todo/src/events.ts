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
