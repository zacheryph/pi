import { customEntries, type BranchSource } from "#session-state";
import {
  applyTodoReview,
  createTodoReviewState,
  readTodoActivity,
  type TodoActivity,
  type TodoReviewState,
} from "#src/activity";
import { applyTodoClaims, TODO_CLAIMS_TYPE, type TodoClaim } from "#src/claims";
import { createEmptyTodoState, readTodoState, type TodoState } from "#src/state";

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

export function replayTodoSession(ctx: BranchSource): TodoSessionSnapshot {
  let state = createEmptyTodoState();
  let activity: TodoActivity = new Map();
  let review = createTodoReviewState();
  let claims = new Map<string, TodoClaim>();
  const types = [TODO_REVIEW_TYPE, TODO_CLAIMS_TYPE, TODO_JOURNAL_TYPE];
  for (const record of customEntries(ctx.sessionManager.getBranch(), types)) {
    if (record.customType === TODO_REVIEW_TYPE) {
      review = applyTodoReview(review, record.data);
      continue;
    }
    if (record.customType === TODO_CLAIMS_TYPE) {
      claims = applyTodoClaims(claims, record.data);
      continue;
    }
    // The journal is the only todo state replayed; a malformed entry keeps the last valid one.
    const next = readTodoState(record.data);
    if (!next) continue;
    state = next;
    activity = readTodoActivity((record.data as { activity?: unknown }).activity, state);
  }
  return { state, activity, review, claims };
}

export function replayTaskState(ctx: BranchSource): TodoState {
  return replayTodoSession(ctx).state;
}
