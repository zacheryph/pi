import { GIT_SNAPSHOT_EVENT, type GitSnapshotEvent } from "#git/events";
import {
  STASH_PREVIEW_REQUEST,
  STASH_SNAPSHOT_EVENT,
  type StashSnapshotEvent,
  type StashPreviewRequest,
  type StashPreviewResult,
} from "#stash/events";
import { SUBAGENT_SNAPSHOT, type SubagentSnapshot } from "#subagent/observation/snapshot";
import { TODO_SNAPSHOT_EVENT, type TodoSnapshotEvent } from "#todo/events";
import { AskUserTracker, type Bus } from "#src/ask-user";
import type { GitSection, StashSection, TodoSection, QuestionnaireAnswer } from "#src/contract";
import { readGit, readPreview, readStash, readTodoHistory, readTodos } from "#src/sections";
import { SubagentTracker } from "#src/subagents";

export type PresentationRequest =
  | { command: "stash-preview"; name: string }
  | { command: "todo-history"; key: string }
  | { command: "answer"; question: string; answer: QuestionnaireAnswer };

/** One consumer of one session's bus; owns no domain state, renderer or transport. */
export class PresentationService {
  private todos?: TodoSection;
  private todoEvent?: TodoSnapshotEvent;
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
      this.todoEvent = data as TodoSnapshotEvent;
      this.todos = readTodos(this.todoEvent);
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
  }

  /** Snapshot reads return copies: UI consumers cannot mutate cached producer state. */
  snapshot() {
    return structuredClone({
      todos: this.todos,
      stash: this.stash,
      git: this.git,
      subagents: this.subagents.section(),
      questions: this.ask.list(),
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
    this.todoEvent = undefined;
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
      case "todo-history": {
        const history = readTodoHistory(this.todoEvent, request.key);
        if (!history) throw new Error(`No task "${request.key}" on this branch.`);
        return history;
      }
      case "stash-preview": {
        let reply: StashPreviewResult | undefined;
        this.bus.emit(STASH_PREVIEW_REQUEST, {
          name: request.name,
          respond: (value) => {
            reply = value;
          },
        } satisfies StashPreviewRequest);
        const preview = readPreview(reply);
        if (typeof preview === "string") throw new Error(preview);
        return preview;
      }
      case "answer":
        return this.ask.answer(request.question, request.answer);
    }
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
