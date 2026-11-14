import {
  SessionManager,
  type BeforeAgentStartEventResult,
  type EventBus,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionToolContext,
  type RegisteredCommand,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { expect, vi } from "vitest";
import { fakePi, messageText, shownOutput } from "#test-helpers";
import todoExtension, { type TodoExtensionDependencies } from "#src/index";
import { todoSettings, type TodoConfig } from "#src/config";
import type { TodoRequest } from "#src/actions";
import type { TodoDetails } from "#src/state";
import { TODO_ARCHIVE_TYPE } from "#src/archive";
import { TODO_JOURNAL_TYPE, TODO_REVIEW_TYPE } from "#src/replay";
import { TODO_SYNC_TYPE } from "#src/sync";

type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;
const isOutput = (message: unknown) => shownOutput({ mock: { calls: [[message]] } }).length > 0;
const isNote = (message: unknown) =>
  (message as { customType?: unknown } | undefined)?.customType === TODO_SYNC_TYPE;
export type TodoTool = ToolDefinition<TSchema, TodoDetails>;

/** A note as Pi hands it on: its custom type, text, visibility and details. */
interface SentNote {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
}
export const T0 = Date.UTC(2026, 9, 22, 12);

export interface HarnessOptions {
  session?: SessionManager;
  cwd?: string;
  mode?: ExtensionContext["mode"];
  hasUI?: boolean;
  config?: Partial<TodoConfig>;
  dependencies?: TodoExtensionDependencies;
  /** A real session bus, so several harnesses can talk through pi-session-tree. */
  events?: EventBus;
}

/**
 * One pi-todo instance on a fake `pi`, with its session entries in a real
 * in-memory `SessionManager`, a print-mode context and a settable clock.
 */
export function harness(options: HarnessOptions = {}) {
  const session = options.session ?? SessionManager.inMemory(options.cwd ?? "/todo-test");
  const record = (note: SentNote) =>
    session.appendCustomMessageEntry(note.customType, note.content, note.display, note.details);
  /** Every text the user was shown: a notification in the terminal, a displayed message elsewhere. */
  const notices = vi.fn<(text: string, level: string) => void>();
  const ui = {
    notify: vi.fn((text: string, level: string) => notices(text, level)),
    setWidget: vi.fn(),
    custom: vi.fn(),
    input: vi
      .fn<(title: string, initial?: string) => Promise<string | undefined>>()
      .mockResolvedValue(undefined),
    select: vi
      .fn<(title: string, choices: string[]) => Promise<string | undefined>>()
      .mockResolvedValue(undefined),
    confirm: vi.fn<(title: string, message: string) => Promise<boolean>>().mockResolvedValue(true),
  };
  const ctx = {
    cwd: session.getCwd(),
    mode: options.mode ?? "print",
    hasUI: options.hasUI ?? false,
    ui,
    sessionManager: session,
  } as unknown as ExtensionCommandContext & ExtensionToolContext;
  const bus = options.events;
  const fake = fakePi({
    appendEntry: vi.fn((type: string, data: unknown) => {
      session.appendCustomEntry(type, data);
    }),
    sendMessage: vi.fn((message: unknown) => {
      // Idle, Pi appends a note to the branch at once.
      if (isNote(message)) record(message as SentNote);
      for (const shown of shownOutput({ mock: { calls: [[message]] } })) {
        notices(shown.text, shown.level);
      }
    }),
    ...(bus
      ? {
          events: {
            emit: (channel: string, data: unknown) => bus.emit(channel, data),
            on: (channel: string, handler: (data: unknown) => void) => bus.on(channel, handler),
          },
        }
      : {}),
  });
  const loadConfig = vi.fn((): TodoConfig => ({ ...todoSettings.defaults(), ...options.config }));
  const saveConfig = vi.fn();
  const clock = { now: T0 };
  todoExtension(fake.api, {
    loadConfig,
    saveConfig,
    now: () => clock.now,
    ...options.dependencies,
  });
  const tools = [...fake.tools.values()] as unknown as TodoTool[];
  const commands = fake.commands as unknown as Map<string, Command>;
  const emit = (name: string, event: object = {}) => fake.emit(name, event, ctx);
  const tool = (action: string) => {
    const found = tools.find((candidate) => candidate.name === `todo_${action}`);
    if (!found) throw new Error(`No todo tool for action: ${action}`);
    return found;
  };
  /** Calls the per-action tool a request names, without its action field. */
  const execute = (request: TodoRequest, signal?: AbortSignal) => {
    const { action, ...input } = request;
    return tool(String(action)).execute("call", input as never, signal, undefined, ctx);
  };
  /** The text a tool call returned to the model. */
  const text = async (request: TodoRequest) => messageText(await execute(request));
  const command = (name: string, args = "") => fake.runCommand(name, args, ctx) as Promise<void>;
  /**
   * Start a run as Pi does: the note `before_agent_start` returns, if any, joins the branch.
   * Returns its text.
   */
  const sync = async () => {
    const result = (await emit("before_agent_start", {
      prompt: "Carry on",
      messageType: "user",
    })) as BeforeAgentStartEventResult | undefined;
    const note = result?.message as SentNote | undefined;
    if (!note) return undefined;
    expect(note).toMatchObject({ customType: TODO_SYNC_TYPE, display: false });
    record(note);
    return note.content;
  };
  /** End a turn; returns the text of the note written for it, if any. */
  const turnEnd = async () => {
    const before = notes().length;
    await emit("turn_end");
    return notes().slice(before).at(-1)?.content;
  };
  /** Put a tool result the model saw on the branch. */
  const see = (result: { content: unknown; details: unknown }, toolName = "todo_upsert") =>
    session.appendMessage({
      role: "toolResult",
      toolCallId: "visible-todo",
      toolName,
      content: result.content,
      details: JSON.parse(JSON.stringify(result.details)),
      isError: false,
      timestamp: 1,
    } as never);
  /** The notes on the branch, oldest first. */
  const notes = () =>
    session
      .getBranch()
      .flatMap((entry) =>
        entry.type === "custom_message" && entry.customType === TODO_SYNC_TYPE
          ? [{ content: entry.content as string, display: entry.display, details: entry.details }]
          : [],
      );
  const state = async () => (await execute({ action: "list" })).details;
  const entriesOf = (type: string) =>
    session.getEntries().filter((e) => e.type === "custom" && e.customType === type);
  const noContinuation = () => {
    // Command output is shown to the user and never continues the session; nor does a note.
    expect(
      fake.pi.sendMessage.mock.calls.filter(
        ([m, options]) =>
          !isOutput(m) &&
          !(isNote(m) && (options as { triggerTurn?: boolean })?.triggerTurn === false),
      ),
    ).toEqual([]);
    expect(fake.pi.sendUserMessage).not.toHaveBeenCalled();
  };
  return {
    session,
    tools,
    commands,
    handlers: fake.handlers,
    ui,
    notices,
    shown: fake.shown,
    ctx,
    pi: fake.pi,
    loadConfig,
    saveConfig,
    clock,
    emit,
    execute,
    text,
    tool,
    command,
    sync,
    turnEnd,
    see,
    notes,
    state,
    snapshots: () => entriesOf(TODO_JOURNAL_TYPE),
    /** The data of each archive journal entry, oldest first. */
    archives: () => entriesOf(TODO_ARCHIVE_TYPE).map((entry) => (entry as { data: unknown }).data),
    reviews: () => entriesOf(TODO_REVIEW_TYPE),
    noContinuation,
  };
}

export type Harness = ReturnType<typeof harness>;

/** A harness after `session_start`. */
export async function started(options: HarnessOptions = {}) {
  const env = harness(options);
  await env.emit("session_start");
  return env;
}
