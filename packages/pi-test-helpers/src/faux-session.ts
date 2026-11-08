/**
 * Real Pi sessions answered by pi-ai's faux provider: offline, no API key, and
 * the responses scripted per test with `faux.setResponses`. Works under vitest
 * and node:test.
 */
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxModelDefinition,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type AgentSession,
  createAgentSession,
  type CreateAgentSessionOptions,
  DefaultResourceLoader,
  type ExtensionError,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { defer, type Defer } from "./cleanup.ts";
import { tempDir } from "./temp.ts";

type FauxCore = ReturnType<typeof createFauxCore>;
type StreamSimple = FauxCore["streamSimple"];
/** What the provider receives for one model request: system prompt, messages and tools. */
export type FauxRequest = Parameters<StreamSimple>[1];
type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
type Settings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;
type Bindings = Parameters<AgentSession["bindExtensions"]>[0];

export interface FauxRuntimeOptions {
  /** Holds `auth.json` and the models cache. */
  dir: string;
  /** Provider name. Default "faux-test". */
  provider?: string;
  /** Default one model, "test". */
  models?: FauxModelDefinition[];
}

/** One provider call: the model, the request and the stream options. */
export type FauxCall = Parameters<StreamSimple>;

/** A model runtime with only the faux provider registered, and every request it got. */
export async function fauxRuntime(options: FauxRuntimeOptions) {
  const provider = options.provider ?? "faux-test";
  const faux = createFauxCore({ provider, models: options.models ?? [{ id: "test" }] });
  const requests: FauxRequest[] = [];
  const calls: FauxCall[] = [];
  const modelRuntime = await ModelRuntime.create({
    authPath: join(options.dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(options.dir, "cache"),
    refreshOnCreate: false,
  });
  const streamSimple: StreamSimple = (model, context, streamOptions) => {
    calls.push([model, context, streamOptions]);
    requests.push(context);
    return faux.streamSimple(model, context, streamOptions);
  };
  modelRuntime.registerProvider(provider, {
    api: faux.api,
    apiKey: "test-key",
    models: faux.models,
    streamSimple,
  });
  return { faux, modelRuntime, requests, calls };
}

export interface FauxSessionOptions extends Partial<FauxRuntimeOptions> {
  /** Disposes the session (and removes the default `dir`) when the test ends. */
  cleanup: Defer;
  /** Working and agent directory. Default: a fresh temp directory. */
  dir?: string;
  /** Inline extensions, loaded in order. Nothing else is loaded. */
  extensions?: InlineExtension[];
  /** Tool allowlist for the session. */
  tools?: string[];
  /** Session manager. Default: in memory, at `dir`. */
  sessionManager?: SessionManager;
  /** Session settings, over compaction and retry both disabled. */
  settings?: Settings;
  /** Resource loader options over the defaults (no discovery of any kind). */
  loader?: Partial<LoaderOptions>;
  /** Further `createAgentSession` options, such as `thinkingLevel`. */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extension bindings. Default: print mode, errors collected in `errors`. */
  bind?: Bindings;
  /** First scripted responses. Default: one reply, "done". */
  responses?: FauxResponseStep[];
}

/**
 * A real `AgentSession` with the given extensions bound, as Pi's print mode
 * binds them, on a faux model.
 */
export async function fauxSession(options: FauxSessionOptions) {
  const dir = options.dir ?? tempDir(options.cleanup, "pi-sdk-");
  const { faux, modelRuntime, requests, calls } = await fauxRuntime({ ...options, dir });
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: options.extensions ?? [],
    ...options.loader,
  });
  await loader.reload();
  const sessionManager = options.sessionManager ?? SessionManager.inMemory(dir);
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader: loader,
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      ...options.settings,
    }),
    ...(options.tools ? { tools: options.tools } : {}),
    ...options.session,
  });
  defer(options.cleanup, async () => {
    try {
      await session.abort();
    } finally {
      session.dispose();
    }
  });
  const errors: ExtensionError[] = [];
  await session.bindExtensions({
    mode: "print",
    onError: (error) => errors.push(error),
    ...options.bind,
  });
  faux.setResponses(options.responses ?? [fauxAssistantMessage("done")]);
  return { session, sessionManager, faux, modelRuntime, requests, calls, errors, dir, loader };
}

export type FauxSession = Awaited<ReturnType<typeof fauxSession>>;

/** A model response that calls one tool and waits for its result. */
export function toolCall(
  name: string,
  args: Record<string, unknown>,
  id?: string,
): AssistantMessage {
  const toolArgs = args as Parameters<typeof fauxToolCall>[1];
  return fauxAssistantMessage(fauxToolCall(name, toolArgs, id ? { id } : undefined), {
    stopReason: "toolUse",
  });
}

type MessageSource =
  | { getBranch(): ReadonlyArray<{ type: string; message?: unknown }> }
  | { messages: readonly unknown[] }
  | readonly unknown[];

function messagesOf(source: MessageSource): unknown[] {
  if (Array.isArray(source)) return [...(source as readonly unknown[])];
  const holder = source as Exclude<MessageSource, readonly unknown[]>;
  if ("messages" in holder) return [...holder.messages];
  return holder.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

/**
 * Tool results for `name`, oldest first, from a session manager's current
 * branch, a session (or provider request) with `messages`, or a message list.
 */
export function toolResults(source: MessageSource, name: string): ToolResultMessage[] {
  return messagesOf(source).filter(
    (message): message is ToolResultMessage =>
      (message as ToolResultMessage).role === "toolResult" &&
      (message as ToolResultMessage).toolName === name,
  );
}

/** The text content of a message, joined. */
export function messageText(message: { content?: unknown } | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) => (block.type === "text" ? block.text : ""))
    .join("");
}

/**
 * Load packages (by directory, as a user's `packages` setting lists them) and
 * extension files through Pi's real loader, with nothing else discovered.
 * Proves the entry points import and register without a build.
 */
export async function loadResources(
  cleanup: Defer,
  sources: { packages?: string[]; extensions?: string[] },
) {
  const dir = tempDir(cleanup, "pi-loader-");
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: SettingsManager.inMemory({ packages: sources.packages ?? [] }),
    additionalExtensionPaths: sources.extensions ?? [],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  return loader.getExtensions();
}
