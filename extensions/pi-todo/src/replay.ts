import { customEntries, type BranchSource } from "#session-state";
import { readTodoActivity, type TodoActivity } from "#src/activity";
import { applyTodoArchive, TODO_ARCHIVE_TYPE, type TodoArchive } from "#src/archive";
import { applyTodoClaims, TODO_CLAIMS_TYPE, type TodoClaim } from "#src/claims";
import { createEmptyTodoState, readTodoState, type TodoState } from "#src/state";

/** Local journals are authoritative; direct results may arrive after newer edits. */
export const TODO_JOURNAL_TYPE = "todo:journal";

export interface TodoSessionSnapshot {
  state: TodoState;
  activity: TodoActivity;
  /** Live subagent claims on this branch, by agent id. */
  claims: Map<string, TodoClaim>;
  /** Completed tasks moved off the list, oldest first. */
  archive: TodoArchive;
}

/** Other entry types, including ones an older pi-todo wrote, are skipped. */
export function replayTodoSession(ctx: BranchSource): TodoSessionSnapshot {
  let state = createEmptyTodoState();
  let activity: TodoActivity = new Map();
  let claims = new Map<string, TodoClaim>();
  let archive: TodoArchive = new Map();
  const types = [TODO_CLAIMS_TYPE, TODO_ARCHIVE_TYPE, TODO_JOURNAL_TYPE];
  for (const record of customEntries(ctx.sessionManager.getBranch(), types)) {
    if (record.customType === TODO_ARCHIVE_TYPE) {
      archive = applyTodoArchive(archive, record.data);
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
  return { state, activity, claims, archive };
}

export function replayTaskState(ctx: BranchSource): TodoState {
  return replayTodoSession(ctx).state;
}
