import { GIT_SNAPSHOT_EVENT, type GitSnapshotEvent } from "#git/events";
import { STASH_PREVIEW_ACTION, STASH_SNAPSHOT_EVENT, type StashSnapshotEvent } from "#stash/events";
import { SUBAGENT_SNAPSHOT, type SubagentSnapshot } from "#subagent/observation/snapshot";
import {
  dispatchAction,
  listActions,
  listViews,
  MAX_VIEW_BYTES,
  onViewChanged,
  readView,
  utf8Bytes,
  type JsonValue,
} from "#surface";
import {
  TODO_HISTORY_ACTION,
  TODO_SNAPSHOT_EVENT,
  type TodoHistoryResult,
  type TodoSnapshotEvent,
} from "#todo/events";
import { AskUserTracker, type Bus } from "#src/ask-user";
import type {
  ActionSummary,
  GitSection,
  PresentationRequest,
  PresentationSnapshot,
  StashSection,
  TodoSection,
  ViewSummary,
} from "#src/contract";
import { readGit, readPreview, readStash, readTaskHistory, readTodos } from "#src/sections";
import { SubagentTracker } from "#src/subagents";

export type { PresentationRequest, PresentationResults, PresentationSnapshot } from "#src/contract";

const MAX_ERROR = 500;
/** Largest view model, as JSON, that a snapshot carries; a larger one is sent as an error. */
export { MAX_VIEW_BYTES };

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR);
}

/** One consumer of one session's bus; owns no domain state, renderer or transport. */
export class PresentationService {
  private todos?: TodoSection;
  private stash?: StashSection;
  private git?: GitSection;
  private subagents = new SubagentTracker();
  private readonly ask: AskUserTracker;
  private readonly remove: Array<() => void> = [];
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(private readonly bus: Bus) {
    const observed: Bus = {
      emit: (channel, data) => bus.emit(channel, data),
      on: (channel, handler) => {
        const off = bus.on(channel, handler);
        this.remove.push(off);
        return off;
      },
    };
    this.ask = new AskUserTracker(observed, () => this.changed());
    observed.on(TODO_SNAPSHOT_EVENT, (data) => {
      this.todos = readTodos(data as TodoSnapshotEvent);
      this.changed();
    });
    observed.on(STASH_SNAPSHOT_EVENT, (data) => {
      this.stash = readStash(data as StashSnapshotEvent);
      this.changed();
    });
    observed.on(GIT_SNAPSHOT_EVENT, (data) => {
      this.git = readGit(data as GitSnapshotEvent);
      this.changed();
    });
    observed.on(SUBAGENT_SNAPSHOT, (data) => {
      if (this.subagents.apply(data as SubagentSnapshot)) this.changed();
    });
    // Every view's model is part of the snapshot. A removed view announces its
    // id after it has gone, so an id no longer on the bus changes the snapshot too.
    onViewChanged(observed, () => this.changed());
  }

  /** Snapshot reads return copies: UI consumers cannot mutate cached producer state. */
  snapshot(): PresentationSnapshot {
    return structuredClone({
      todos: this.todos,
      stash: this.stash,
      git: this.git,
      subagents: this.subagents.section(),
      questions: this.ask.list(),
      views: this.views(),
    });
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) throw new Error("Presentation service is disposed.");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  closeQuestion(id: string): void {
    this.ask.close(id);
  }

  /** Lifecycle owner resets when replacing the session; producer snapshots repopulate it. */
  reset(): void {
    this.todos = undefined;
    this.stash = undefined;
    this.git = undefined;
    this.subagents = new SubagentTracker();
    this.ask.clear();
    this.changed();
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.remove.splice(0)) off();
    this.listeners.clear();
    this.reset();
  }

  async request(request: PresentationRequest): Promise<unknown> {
    if (this.disposed) throw new Error("Presentation service is disposed.");
    switch (request.command) {
      case "view": {
        if (typeof request.id !== "string") throw new Error("view needs an id.");
        return readView(this.bus, request.id) ?? null;
      }
      case "actions":
        return listActions(this.bus).map(({ id, title }): ActionSummary => ({ id, title }));
      case "action": {
        if (typeof request.id !== "string") throw new Error("action needs an id.");
        return (await dispatchAction(this.bus, request.id, request.args)) ?? null;
      }
      // The three requests below predate actions; each is now its producer's action,
      // bounded for the wire and with the errors it always had.
      case "todo-history": {
        const missing = `No task "${request.key}" on this branch.`;
        const result = await this.dispatchOwned(TODO_HISTORY_ACTION, { key: request.key }, missing);
        return readTaskHistory(result as unknown as TodoHistoryResult);
      }
      case "stash-preview": {
        const result = await this.dispatchOwned(
          STASH_PREVIEW_ACTION,
          { name: request.name },
          "pi-stash did not answer; is it loaded?",
        );
        const preview = readPreview({ ok: true, ...(result as object) } as Parameters<
          typeof readPreview
        >[0]);
        if (typeof preview === "string") throw new Error(preview);
        return preview;
      }
      case "answer":
        return this.ask.answer(request.question, request.answer);
    }
  }

  /** An alias's action: `absent` when its extension is not loaded, else its result or bounded error. */
  private async dispatchOwned(id: string, args: JsonValue, absent: string): Promise<JsonValue> {
    if (!listActions(this.bus).some((action) => action.id === id)) throw new Error(absent);
    let result: JsonValue | undefined;
    try {
      result = await dispatchAction(this.bus, id, args);
    } catch (error) {
      throw new Error(message(error), { cause: error });
    }
    if (typeof result !== "object" || result === null || Array.isArray(result))
      throw new Error(`Action "${id}" returned no result.`);
    return result;
  }

  private viewInfo() {
    try {
      return listViews(this.bus);
    } catch {
      // A bus Pi has retired after shutdown or reload throws; it offers nothing.
      return [];
    }
  }

  private views(): ViewSummary[] {
    if (this.disposed) return [];
    return this.viewInfo().map(({ id, kind, title }): ViewSummary => {
      const entry = { id, kind, title } as ViewSummary;
      try {
        const model = readView(this.bus, id);
        if (model === undefined) return entry;
        const bytes = utf8Bytes(JSON.stringify(model));
        if (bytes > MAX_VIEW_BYTES)
          return {
            ...entry,
            error: `Too large to send: ${Math.ceil(bytes / 1024)} KB, over ${MAX_VIEW_BYTES / 1024} KB.`,
          };
        return { ...entry, model } as ViewSummary;
      } catch (error) {
        return { ...entry, error: message(error) };
      }
    });
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
