import { isJsonObject, type ActionDefinition, type JsonValue } from "#surface";
import {
  type TodoActivity,
  type TodoReview,
  todoReviewMarks,
  type TodoReviewState,
} from "#src/activity";
import {
  TODO_HISTORY_ACTION,
  TODO_INSPECT_ACTION,
  TODO_REVIEW_ACTION,
  type TodoHistoryResult,
} from "#src/events";
import type { TodoState, TodoTask } from "#src/state";
import { todoTaskDetail } from "#src/ui/render";

/** What pi-todo's actions read and the one write they make. */
export interface TodoSurfaceSource {
  state(): TodoState;
  activity(): TodoActivity;
  review(): TodoReviewState;
  /** Subagent holding each delegated task, as a display label. */
  assignees(): ReadonlyMap<string, string>;
  now(): number;
  /** Changes whenever the session or branch is replaced. */
  branch(): number;
  /** Journals review watermarks that advance; returns how many tasks advanced. */
  markReviewed(marks: ReadonlyMap<string, number>): number;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function task(source: TodoSurfaceSource, key: string): TodoTask {
  const found = source.state().tasks.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`No task "${key}" on this branch.`);
  return found;
}

function keyArg(args: JsonValue | undefined, name: "id" | "key"): string {
  if (!isJsonObject(args) || typeof args[name] !== "string")
    throw new Error(`expected { ${name}: <task key> }`);
  return args[name];
}

function stringsArg(value: JsonValue | undefined, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${name} must be an array of task keys`);
  return value as string[];
}

/** `todo.inspect`: one task's detail blocks. */
export function todoInspectAction(
  source: TodoSurfaceSource,
): ActionDefinition<{ id: string; reviewed?: ReadonlyMap<string, TodoReview> }> {
  return {
    id: TODO_INSPECT_ACTION,
    title: "Show a task's details, dependencies and history",
    parse: (args) => {
      const id = keyArg(args, "id");
      const raw = isJsonObject(args) ? args.reviewed : undefined;
      if (raw === undefined) return { id };
      if (!isJsonObject(raw)) throw new Error("reviewed must map task keys to { revision, at }");
      const reviewed = new Map<string, TodoReview>();
      for (const [key, value] of Object.entries(raw))
        if (isJsonObject(value) && isCount(value.revision) && isCount(value.at))
          reviewed.set(key, { revision: value.revision, at: value.at });
      return { id, reviewed };
    },
    handler: ({ id, reviewed }) => {
      const state = source.state();
      const live = source.review();
      const review: TodoReviewState = reviewed ? { ...live, tasks: reviewed } : live;
      return todoTaskDetail(
        task(source, id),
        state,
        { activity: source.activity(), review, now: source.now() },
        source.assignees().get(id),
      );
    },
  };
}

interface ReviewArgs {
  ids?: string[];
  revisions?: Map<string, number>;
  branch?: number;
}

/** `todo.review`: mark messages reviewed, as `/todo:review` and the browser's marker do. */
export function todoReviewAction(source: TodoSurfaceSource): ActionDefinition<ReviewArgs> {
  return {
    id: TODO_REVIEW_ACTION,
    title: "Mark task messages reviewed",
    parse: (args) => {
      if (args === undefined) return {};
      if (!isJsonObject(args)) throw new Error("expected { ids?, revisions?, branch? }");
      const parsed: ReviewArgs = {};
      const ids = stringsArg(args.ids, "ids");
      if (ids) parsed.ids = ids;
      if (args.revisions !== undefined) {
        if (!isJsonObject(args.revisions))
          throw new Error("revisions must map task keys to revisions");
        parsed.revisions = new Map(
          Object.entries(args.revisions).flatMap(([key, value]) =>
            isCount(value) ? [[key, value] as const] : [],
          ),
        );
      }
      if (args.branch !== undefined) {
        if (!isCount(args.branch)) throw new Error("branch must be a number");
        parsed.branch = args.branch;
      }
      return parsed;
    },
    handler: ({ ids, revisions, branch }) => {
      if (branch !== undefined && branch !== source.branch())
        throw new Error("The task list changed branch or session; reopen it to review.");
      let marks: Map<string, number>;
      if (revisions) {
        marks = new Map();
        for (const key of ids ?? revisions.keys()) {
          const revision = revisions.get(key);
          if (revision !== undefined) marks.set(key, revision);
        }
      } else {
        const state = source.state();
        for (const key of ids ?? []) task(source, key);
        marks = todoReviewMarks(state, source.activity(), source.review(), ids);
      }
      return { reviewed: marks.size ? source.markReviewed(marks) : 0 };
    },
  };
}

/** `todo.history`: one task's creation time and history, as the snapshot event carries it. */
export function todoHistoryAction(source: TodoSurfaceSource): ActionDefinition<{ key: string }> {
  return {
    id: TODO_HISTORY_ACTION,
    title: "Read a task's status and message history",
    parse: (args) => ({ key: keyArg(args, "key") }),
    handler: ({ key }) => {
      task(source, key);
      const history = source.activity().get(key);
      const result: TodoHistoryResult = structuredClone({
        key,
        ...(history?.createdAt !== undefined ? { createdAt: history.createdAt } : {}),
        updates: history?.updates ?? [],
      });
      // TodoUpdate is an interface, so TypeScript cannot see that it is JSON; dispatch checks it.
      return result as unknown as JsonValue;
    },
  };
}
