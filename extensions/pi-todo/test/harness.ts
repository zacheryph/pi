import {
  SessionManager,
  type ContextEvent,
  type ContextEventResult,
  type EventBus,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionToolContext,
  type RegisteredCommand,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { expect, vi } from "vitest";
import { fakePi } from "../../../packages/pi-test-helpers/src/fake-pi.ts";
import todoExtension, { type TodoExtensionDependencies } from "../src/index.ts";
import { DEFAULT_CONFIG, type TodoConfig } from "../src/config.ts";
import type { TodoRequest } from "../src/actions.ts";
import type { TodoDetails } from "../src/state.ts";
import { TODO_JOURNAL_TYPE, TODO_REVIEW_TYPE } from "../src/replay.ts";

type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;
export type TodoTool = ToolDefinition<TSchema, TodoDetails>;
export const CONTEXT_TYPE = "todo:context";
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
  const ui = {
    notify: vi.fn(),
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
    ...(bus
      ? {
          events: {
            emit: (channel: string, data: unknown) => bus.emit(channel, data),
            on: (channel: string, handler: (data: unknown) => void) => bus.on(channel, handler),
          },
        }
      : {}),
  });
  const loadConfig = vi.fn(() => ({ ...DEFAULT_CONFIG, ...options.config }));
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
  const text = async (request: TodoRequest) =>
    (await execute(request)).content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  const command = (name: string, args = "") => fake.runCommand(name, args, ctx) as Promise<void>;
  const context = async (messages: ContextEvent["messages"] = []) =>
    (await emit("context", { messages })) as ContextEventResult | undefined;
  const state = async () => (await execute({ action: "list" })).details;
  const entriesOf = (type: string) =>
    session.getEntries().filter((e) => e.type === "custom" && e.customType === type);
  const noContinuation = () => {
    expect(fake.pi.sendMessage).not.toHaveBeenCalled();
    expect(fake.pi.sendUserMessage).not.toHaveBeenCalled();
  };
  return {
    session,
    tools,
    commands,
    handlers: fake.handlers,
    ui,
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
    context,
    state,
    snapshots: () => entriesOf(TODO_JOURNAL_TYPE),
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
