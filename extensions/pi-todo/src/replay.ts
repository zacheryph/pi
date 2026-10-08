import { createEmptyTodoState, replayTodoState, TODO_SCHEMA_VERSION, TODO_STATE_CUSTOM_TYPE, type TodoState } from "./state.ts";

/** Local journals are authoritative; direct results may arrive after newer edits. */
export const TODO_JOURNAL_TYPE = "pi-personal:todo-state";

export function replayTaskState(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TodoState {
  const branch = [...ctx.sessionManager.getBranch()];
  let journal: TodoState | undefined;
  for (const entry of branch) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (record.type !== "custom" || record.customType !== TODO_JOURNAL_TYPE || !record.data || typeof record.data !== "object") continue;
    const raw = record.data as { schemaVersion?: unknown; revision?: unknown; tasks?: unknown };
    if (raw.schemaVersion !== TODO_SCHEMA_VERSION || !Array.isArray(raw.tasks)) continue;
    // Reuse upstream's complete validation/normalization, not a second DAG parser.
    const state = replayTodoState({ sessionManager: { getBranch: () => [{
      type: "custom", customType: TODO_STATE_CUSTOM_TYPE, data: raw,
    }] } });
    // Invalid snapshots replay as empty revision zero. Length + revision checks
    // distinguish that fallback; the valid zero/empty state is itself safe.
    if (state.revision === raw.revision && state.tasks.length === raw.tasks.length) journal = state;
  }
  return journal ?? (branch.length ? replayTodoState({ sessionManager: { getBranch: () => branch } }) : createEmptyTodoState());
}
