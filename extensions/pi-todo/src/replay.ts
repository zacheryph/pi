import {
  applyTodoReview, createTodoReviewState, readTodoActivity, type TodoActivity, type TodoReviewState,
} from "./activity.ts";
import { applyTodoClaims, TODO_CLAIMS_TYPE, type TodoClaim } from "./claims.ts";
import { createEmptyTodoState, replayTodoState, TODO_SCHEMA_VERSION, TODO_STATE_CUSTOM_TYPE, type TodoState } from "./state.ts";

/** Local journals are authoritative; direct results may arrive after newer edits. */
export const TODO_JOURNAL_TYPE = "pi-personal:todo-state";
/** Append-only user review watermarks; never part of plan state or model context. */
export const TODO_REVIEW_TYPE = "pi-personal:todo-review";

export interface TodoSessionSnapshot {
  state: TodoState;
  activity: TodoActivity;
  review: TodoReviewState;
  /** Live subagent claims on this branch, by agent id. */
  claims: Map<string, TodoClaim>;
}

export function replayTodoSession(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TodoSessionSnapshot {
  const branch = [...ctx.sessionManager.getBranch()];
  let journal: { state: TodoState; activity: TodoActivity } | undefined;
  let review = createTodoReviewState();
  let claims = new Map<string, TodoClaim>();
  for (const entry of branch) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (record.type !== "custom") continue;
    if (record.customType === TODO_REVIEW_TYPE) {
      review = applyTodoReview(review, record.data);
      continue;
    }
    if (record.customType === TODO_CLAIMS_TYPE) {
      claims = applyTodoClaims(claims, record.data);
      continue;
    }
    if (record.customType !== TODO_JOURNAL_TYPE || !record.data || typeof record.data !== "object") continue;
    const raw = record.data as { schemaVersion?: unknown; revision?: unknown; tasks?: unknown; activity?: unknown };
    if (raw.schemaVersion !== TODO_SCHEMA_VERSION || !Array.isArray(raw.tasks)) continue;
    // Reuse upstream's complete validation/normalization, not a second DAG parser.
    const state = replayTodoState({ sessionManager: { getBranch: () => [{
      type: "custom", customType: TODO_STATE_CUSTOM_TYPE, data: raw,
    }] } });
    // Invalid snapshots replay as empty revision zero. Length + revision checks
    // distinguish that fallback; the valid zero/empty state is itself safe.
    if (state.revision === raw.revision && state.tasks.length === raw.tasks.length) {
      journal = { state, activity: readTodoActivity(raw.activity, state) };
    }
  }
  if (journal) return { ...journal, review, claims };
  const state = branch.length ? replayTodoState({ sessionManager: { getBranch: () => branch } }) : createEmptyTodoState();
  return { state, activity: new Map(), review, claims };
}

export function replayTaskState(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TodoState {
  return replayTodoSession(ctx).state;
}
