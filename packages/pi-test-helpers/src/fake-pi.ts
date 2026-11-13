/**
 * A fake `ExtensionAPI` for unit tests of an extension factory (vitest only:
 * every method is a `vi.fn` spy). It records what the factory registers and
 * lets the test fire Pi's events, run tools and run commands.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

/* oxlint-disable typescript/no-explicit-any -- Handlers and tools are typed by each extension. */
type Handler = (event: any, ctx: any) => unknown;
type Listener = (data: any) => void;

/** The parts of a tool definition tests call. */
export interface FakeTool {
  name: string;
  execute: (...args: any[]) => any;
  [key: string]: any;
}

/** The parts of a command definition tests call. */
export interface FakeCommand {
  handler: (args: string, ctx: any) => any;
  [key: string]: any;
}
/* oxlint-enable typescript/no-explicit-any */

export interface CustomEntry {
  type: "custom";
  customType: string;
  data: unknown;
}

/** A session-scoped event bus like `pi.events`, recording every emit. */
export function fakeEventBus() {
  const listeners = new Map<string, Listener[]>();
  const emitted: Array<[channel: string, data: unknown]> = [];
  const bus = {
    on: vi.fn((channel: string, listener: Listener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      return () => {
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((candidate) => candidate !== listener),
        );
      };
    }),
    emit: vi.fn((channel: string, data: unknown) => {
      emitted.push([channel, data]);
      for (const listener of listeners.get(channel) ?? []) listener(data);
    }),
    /** Every `[channel, data]` emitted so far, in order. */
    emitted,
    /** Data emitted on one channel, in order. */
    published: (channel: string) => emitted.filter(([name]) => name === channel).map(([, d]) => d),
  };
  return bus;
}

export type FakeEventBus = ReturnType<typeof fakeEventBus>;

/** A command's text as pi-foundations' `userOutput` sent it outside the terminal. */
export interface ShownOutput {
  customType: string;
  /** The message content, with the "Warning: " or "Error: " lead-in. */
  content: string;
  /** The content without the lead-in. */
  text: string;
  level: "info" | "warning" | "error";
  display: boolean;
  options: unknown;
}

const LEAD_IN = { info: "", warning: "Warning: ", error: "Error: " } as const;

/** The displayed custom messages `sendMessage` received from `userOutput`, in order. */
export function shownOutput(sendMessage: { mock: { calls: unknown[][] } }): ShownOutput[] {
  const shown: ShownOutput[] = [];
  for (const [message, options] of sendMessage.mock.calls) {
    const sent = message as {
      customType?: string;
      content?: unknown;
      display?: boolean;
      details?: { userOutput?: boolean; level?: ShownOutput["level"] };
    };
    if (sent.details?.userOutput !== true || typeof sent.content !== "string") continue;
    const level = sent.details.level ?? "info";
    shown.push({
      customType: sent.customType ?? "",
      content: sent.content,
      text: sent.content.startsWith(LEAD_IN[level])
        ? sent.content.slice(LEAD_IN[level].length)
        : sent.content,
      level,
      display: sent.display === true,
      options,
    });
  }
  return shown;
}

/**
 * Build the fake. `extra` adds or replaces `ExtensionAPI` members, such as
 * `getSessionName`, `exec`, or an `appendEntry` that writes to a real
 * `SessionManager`.
 */
export function fakePi<Extra extends object = object>(extra: Extra = {} as Extra) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, FakeTool>();
  const commands = new Map<string, FakeCommand>();
  /** Entries the default `appendEntry` recorded. */
  const entries: CustomEntry[] = [];
  const events = fakeEventBus();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    }),
    registerTool: vi.fn((tool: FakeTool) => {
      tools.set(tool.name, tool);
    }),
    registerCommand: vi.fn((name: string, command: FakeCommand) => {
      commands.set(name, command);
    }),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    events,
    ...extra,
  };

  const tool = (name: string): FakeTool => {
    const found = tools.get(name);
    if (!found) throw new Error(`Tool not registered: ${name}`);
    return found;
  };
  const command = (name: string): FakeCommand => {
    const found = commands.get(name);
    if (!found) throw new Error(`Command not registered: ${name}`);
    return found;
  };

  return {
    /** The fake with its spies, for assertions. */
    pi,
    /** The same object typed for an extension factory. */
    api: pi as unknown as ExtensionAPI,
    handlers,
    tools,
    commands,
    entries,
    events,
    /** What `userOutput` showed through `sendMessage`, in order. */
    shown: () => shownOutput(pi.sendMessage),
    tool,
    command,
    /**
     * Run every handler for `event` in registration order, awaiting each, as Pi
     * does. The event object is `{ type: event, ...payload }`. Returns the last
     * handler's result.
     */
    emit: async (event: string, payload: object = {}, ctx?: unknown): Promise<unknown> => {
      let result: unknown;
      for (const handler of handlers.get(event) ?? [])
        result = await handler({ type: event, ...payload }, ctx);
      return result;
    },
    /** Execute a registered tool as Pi would. */
    runTool: (
      name: string,
      params: unknown,
      ctx?: unknown,
      options: { id?: string; signal?: AbortSignal; onUpdate?: (update: unknown) => void } = {},
    ) => tool(name).execute(options.id ?? "call-1", params, options.signal, options.onUpdate, ctx),
    /** Run a registered command's handler. */
    runCommand: (name: string, args = "", ctx?: unknown) => command(name).handler(args, ctx),
  };
}

export type FakePi = ReturnType<typeof fakePi>;
