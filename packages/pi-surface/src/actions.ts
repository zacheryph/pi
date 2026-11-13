import { isJsonValue, type JsonValue } from "#src/json";

/**
 * The session's event bus (`pi.events`). Every session, subagents included, has
 * its own, so actions defined on one are invisible to the others.
 */
export interface ActionBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

/**
 * The bus channel that carries list and dispatch requests. Each extension loads
 * its own copy of this library, so the registry is the set of listeners on the
 * session's bus rather than a shared object.
 */
export const ACTIONS_CHANNEL = "surface:actions";
export const ACTIONS_VERSION = 1;

/** `<extension>.<verb>`: lowercase segments separated by dots, e.g. `git.worktree.remove`. */
export const ACTION_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

export interface ActionInfo {
  id: string;
  title: string;
}

export interface ActionDefinition<Args = JsonValue | undefined> extends ActionInfo {
  /**
   * Checks and converts the arguments; throw to refuse them. The dispatch
   * rejects with `Invalid arguments for "<id>": <message>`. Without it the
   * handler receives the JSON arguments as given.
   */
  parse?: (args: JsonValue | undefined) => Args;
  handler: (args: Args) => JsonValue | void | Promise<JsonValue | void>;
}

type ActionRequest = { version: typeof ACTIONS_VERSION } & (
  | { kind: "list"; add(info: ActionInfo): void }
  | {
      kind: "dispatch";
      id: string;
      args: JsonValue | undefined;
      respond(result: Promise<JsonValue | undefined>): void;
    }
);

function request(bus: ActionBus, data: ActionRequest): void {
  bus.emit(ACTIONS_CHANNEL, data);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function run<Args>(
  action: ActionDefinition<Args>,
  args: JsonValue | undefined,
): Promise<JsonValue | undefined> {
  let parsed: Args;
  try {
    parsed = action.parse ? action.parse(args) : (args as Args);
  } catch (error) {
    throw new Error(`Invalid arguments for "${action.id}": ${message(error)}`, { cause: error });
  }
  const result: unknown = await action.handler(parsed);
  if (result === undefined) return undefined;
  if (!isJsonValue(result))
    throw new Error(`Action "${action.id}" returned a value that is not JSON.`);
  return result;
}

/** Actions defined on this bus, sorted by id. */
export function listActions(bus: ActionBus): ActionInfo[] {
  const found: ActionInfo[] = [];
  request(bus, { version: ACTIONS_VERSION, kind: "list", add: (info) => found.push(info) });
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Define an action on this session's bus. Throws for a malformed id or one
 * already defined on the bus. Returns the function that removes it.
 */
export function defineAction<Args = JsonValue | undefined>(
  bus: ActionBus,
  definition: ActionDefinition<Args>,
): () => void {
  const { id, title } = definition;
  if (typeof id !== "string" || !ACTION_ID.test(id))
    throw new Error(
      `Invalid action id "${String(id)}": use lowercase <extension>.<verb>, e.g. "stash.inspect".`,
    );
  if (typeof title !== "string" || !title.trim()) throw new Error(`Action "${id}" needs a title.`);
  if (listActions(bus).some((action) => action.id === id))
    throw new Error(`Action "${id}" is already defined on this session.`);
  const action = { ...definition };
  return bus.on(ACTIONS_CHANNEL, (data) => {
    const req = data as ActionRequest | null | undefined;
    if (req?.version !== ACTIONS_VERSION) return;
    if (req.kind === "list") req.add({ id, title });
    else if (req.kind === "dispatch" && req.id === id) req.respond(run(action, req.args));
  });
}

/**
 * Run an action defined on this bus. Rejects when no action has that id, when
 * the arguments are not JSON or fail the action's `parse`, and with the
 * handler's own error.
 */
export function dispatchAction(
  bus: ActionBus,
  id: string,
  args?: JsonValue,
): Promise<JsonValue | undefined> {
  if (args !== undefined && !isJsonValue(args))
    return Promise.reject(new Error(`Arguments for action "${id}" are not JSON.`));
  let result: Promise<JsonValue | undefined> | undefined;
  request(bus, {
    version: ACTIONS_VERSION,
    kind: "dispatch",
    id,
    args,
    respond: (value) => {
      result ??= value;
    },
  });
  return result ?? Promise.reject(new Error(`Unknown action "${id}".`));
}

export interface ActionRegistry {
  /** Define an action; it is removed by the returned function or by `dispose`. */
  define<Args = JsonValue | undefined>(definition: ActionDefinition<Args>): () => void;
  list(): ActionInfo[];
  dispatch(id: string, args?: JsonValue): Promise<JsonValue | undefined>;
  /** Remove every action this registry defined. Call it from `session_shutdown`. */
  dispose(): void;
}

/** A handle on one session's bus that remembers what it defined, so one call removes it all. */
export function actionRegistry(bus: ActionBus): ActionRegistry {
  const owned = new Set<() => void>();
  return {
    define(definition) {
      const remove = defineAction(bus, definition);
      const dispose = () => {
        if (owned.delete(dispose)) remove();
      };
      owned.add(dispose);
      return dispose;
    },
    list: () => listActions(bus),
    dispatch: (id, args) => dispatchAction(bus, id, args),
    dispose() {
      // Each dispose deletes itself; deleting the current entry is safe while iterating a Set.
      for (const dispose of owned) dispose();
    },
  };
}
