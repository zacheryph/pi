import { isJsonObject, type ActionDefinition, type JsonValue } from "#surface";
import type { TodoActivity } from "#src/activity";
import { TODO_INSPECT_ACTION } from "#src/events";
import type { TodoState, TodoTask } from "#src/state";
import { todoTaskDetail } from "#src/ui/render";

/** What pi-todo's actions read. */
export interface TodoSurfaceSource {
  state(): TodoState;
  activity(): TodoActivity;
  /** Subagent holding each delegated task, as a display label. */
  assignees(): ReadonlyMap<string, string>;
  now(): number;
}

function task(source: TodoSurfaceSource, key: string): TodoTask {
  const found = source.state().tasks.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`No task "${key}" on this branch.`);
  return found;
}

function idArg(args: JsonValue | undefined): string {
  if (!isJsonObject(args) || typeof args.id !== "string")
    throw new Error("expected { id: <task key> }");
  return args.id;
}

/** `todo.inspect`: one task's detail blocks. */
export function todoInspectAction(source: TodoSurfaceSource): ActionDefinition<{ id: string }> {
  return {
    id: TODO_INSPECT_ACTION,
    title: "Show a task's details, dependencies and history",
    parse: (args) => ({ id: idArg(args) }),
    handler: ({ id }) =>
      todoTaskDetail(
        task(source, id),
        source.state(),
        { activity: source.activity(), now: source.now() },
        source.assignees().get(id),
      ),
  };
}
