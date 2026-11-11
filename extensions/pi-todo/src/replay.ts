import {
  applyTodoReview,
  createTodoReviewState,
  readTodoActivity,
  type TodoActivity,
  type TodoReviewState,
} from "./activity.ts";
import { applyTodoClaims, TODO_CLAIMS_TYPE, type TodoClaim } from "./claims.ts";
import { createEmptyTodoState, readTodoState, type TodoState } from "./state.ts";

/** Local journals are authoritative; direct results may arrive after newer edits. */
export const TODO_JOURNAL_TYPE = "todo:journal";
/** Append-only user review watermarks; never part of plan state or model context. */
export const TODO_REVIEW_TYPE = "todo:review";

export interface TodoSessionSnapshot {
  state: TodoState;
  activity: TodoActivity;
  review: TodoReviewState;
  /** Live subagent claims on this branch, by agent id. */
  claims: Map<string, TodoClaim>;
}

export function replayTodoSession(ctx: {
  sessionManager: { getBranch(): Iterable<unknown> };
}): TodoSessionSnapshot {
  let state = createEmptyTodoState();
  let activity: TodoActivity = new Map();
  let review = createTodoReviewState();
  let claims = new Map<string, TodoClaim>();
  for (const entry of ctx.sessionManager.getBranch()) {
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
    if (record.customType !== TODO_JOURNAL_TYPE) continue;
    // The journal is the only todo state replayed; a malformed entry keeps the last valid one.
    const next = readTodoState(record.data);
    if (!next) continue;
    state = next;
    activity = readTodoActivity((record.data as { activity?: unknown }).activity, state);
  }
  return { state, activity, review, claims };
}

export function replayTaskState(ctx: {
  sessionManager: { getBranch(): Iterable<unknown> };
}): TodoState {
  return replayTodoSession(ctx).state;
}
