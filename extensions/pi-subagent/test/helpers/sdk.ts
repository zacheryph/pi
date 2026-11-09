/**
 * Real child sessions for SDK tests: the agent directory children load their
 * settings and extensions from, and a `createSubagentSession` wired to real
 * session, settings and resource-loader factories on a faux model.
 */
import { join, resolve } from "node:path";
import type { FauxModelDefinition } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { onTestFinished, vi } from "vitest";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  fauxRuntime,
  toolCall,
  toolResults,
} from "../../../../packages/pi-test-helpers/src/faux-session.ts";
import { clearSlots, slots } from "../../../../packages/pi-test-helpers/src/globals.ts";
import { tempDir, writeFiles } from "../../../../packages/pi-test-helpers/src/temp.ts";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { createChildLifecyclePublisher } from "#src/lifecycle/child-lifecycle";
import { createSubagentSession } from "#src/lifecycle/create-subagent-session";
import { buildAgentPrompt } from "#src/session/prompts";
import { LIFECYCLE_LOG } from "../fixtures/lifecycle-recorder.ts";

/** Extension entry points children can load, by name. */
export const EXTENSIONS = {
  subagent: resolve(import.meta.dirname, "../../src/index.ts"),
  ask: resolve(import.meta.dirname, "../../../pi-ask/src/index.ts"),
  stash: resolve(import.meta.dirname, "../../../pi-stash/src/index.ts"),
  todo: resolve(import.meta.dirname, "../../../pi-todo/src/index.ts"),
  lifecycleRecorder: resolve(import.meta.dirname, "../fixtures/lifecycle-recorder.ts"),
};

/** The built-in tools a parent session has. */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
export const SUBAGENT_TOOLS = ["subagent_start", "subagent_get", "subagent_send"];
export const TODO_TOOLS = ["todo_list", "todo_upsert", "todo_replace", "todo_remove", "todo_clear"];

export interface AgentDirOptions {
  /** Extension files every child session loads, as a user's settings list them. */
  extensions?: string[];
  /** More files for the agent directory, such as `subagent.json` or `agents/x.md`. */
  files?: Record<string, string | object>;
}

/**
 * A throwaway agent directory for this test: `PI_CODING_AGENT_DIR` points at
 * it, its `settings.json` lists `extensions` with compaction and retry off, and
 * every `ModelRuntime` skips the network refresh. All undone when the test ends.
 */
export function offlineAgentDir(options: AgentDirOptions = {}): string {
  const dir = tempDir(onTestFinished, "subagent-sdk-");
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const create = ModelRuntime.create.bind(ModelRuntime);
  const offline = vi
    .spyOn(ModelRuntime, "create")
    .mockImplementation((runtimeOptions) => create({ ...runtimeOptions, refreshOnCreate: false }));
  onTestFinished(() => offline.mockRestore());
  writeFiles(dir, {
    "settings.json": {
      extensions: options.extensions ?? [],
      compaction: { enabled: false },
      retry: { enabled: false },
    },
    ...options.files,
  });
  return dir;
}

export interface RealChildOptions {
  /** Agent type to run, such as "orchestrate" or "explore". */
  type: string;
  /** Faux provider name. */
  provider: string;
  models?: FauxModelDefinition[];
  /** Tool names the parent offers; children inherit from these. */
  parentTools?: string[];
  /** The parent's system prompt. Default "PROJECT BASE". */
  systemPrompt?: string;
  registry?: AgentTypeRegistry;
  /** Pass the faux model explicitly as the child's model, not only the parent's. */
  pinModel?: boolean;
}

/**
 * A child session of `type`, created as pi-subagent creates one, in the agent
 * directory `dir` (see `offlineAgentDir`). Disposed when the test ends, or
 * earlier by the test; a second dispose does nothing.
 */
export async function realChildSession(dir: string, options: RealChildOptions) {
  const { faux, modelRuntime: runtime } = await fauxRuntime({
    dir,
    provider: options.provider,
    models: options.models ?? [{ id: "coordinator" }],
  });
  const parentTools = options.parentTools ?? [...BUILTIN_TOOLS, ...SUBAGENT_TOOLS];
  const session = await createSubagentSession(
    {
      type: options.type,
      ...(options.pinModel ? { model: faux.getModel() } : {}),
      snapshot: {
        cwd: dir,
        systemPrompt: options.systemPrompt ?? "PROJECT BASE",
        model: faux.getModel(),
        modelRegistry: new ModelRegistry(runtime),
      },
    },
    {
      registry: options.registry ?? new AgentTypeRegistry(() => new Map()),
      exec: vi.fn(),
      lifecycle: createChildLifecyclePublisher(() => {}),
      resolvePromptInheritance: () => "full",
      listParentToolNames: () => parentTools,
      io: {
        detectEnv: async () => ({ isGitRepo: false, branch: "", platform: "linux" }),
        getAgentDir: () => dir,
        deriveSessionDir: () => join(dir, "sessions"),
        createSessionManager: (cwd, sessionDir) => SessionManager.create(cwd, sessionDir),
        openSessionManager: (path, cwd) => SessionManager.open(path, undefined, cwd),
        createSettingsManager: (cwd, agentDir) => SettingsManager.create(cwd, agentDir),
        createLoaderSettingsManager: (settings) => settings,
        createResourceLoader: (loaderOptions) =>
          new DefaultResourceLoader({ ...loaderOptions, noSkills: true }),
        createSession: async ({
          sessionManager,
          resourceLoader,
          modelRegistry: _registry,
          ...rest
        }) =>
          createAgentSession({
            ...rest,
            sessionManager: sessionManager as SessionManager,
            resourceLoader: resourceLoader as ResourceLoader,
            modelRuntime: runtime,
          }),
        assemblerIO: { buildAgentPrompt, loadProjectContext: () => undefined },
      },
    },
  );
  const dispose = session.dispose.bind(session);
  let disposed: Promise<void> | undefined;
  session.dispose = () => (disposed ??= dispose());
  onTestFinished(() => session.dispose());
  return { session, faux, runtime };
}

/** The latest result `tool` returned in a provider request, as JSON. */
export const lastResult = (request: { messages: readonly unknown[] }, tool: string) =>
  JSON.stringify(toolResults(request, tool).at(-1));

/** The agent ID a subagent_start result announces. */
export const agentIdIn = (text: string) => /Agent ID: ([\w-]+)/.exec(text)?.[1];

export interface LifecycleEntry {
  channel: string;
  data: Record<string, unknown>;
}

/**
 * Start an empty log for `fixtures/lifecycle-recorder.ts` (listed in the
 * agent directory's extensions) and return a reader for it.
 */
export function lifecycleLog(): () => LifecycleEntry[] {
  slots[LIFECYCLE_LOG] = [];
  onTestFinished(() => clearSlots(LIFECYCLE_LOG));
  return () => slots[LIFECYCLE_LOG] as LifecycleEntry[];
}

/** A model response that spawns a general-purpose worker whose prompt is `description.`. */
export const spawn = (description: string, extra: Record<string, unknown> = {}) =>
  toolCall("subagent_start", {
    subagent_type: "general-purpose",
    description,
    prompt: `${description}.`,
    ...extra,
  });

/**
 * A scripted response that keeps a copy of the request it answers. One faux
 * provider answers the parent and its children in call order, so this tells
 * whose request a reply saw. Assert after the prompt: an exception thrown
 * inside a response is swallowed as a provider error.
 */
export function capture(requests: Context[], reply: AssistantMessage) {
  return (request: Context) => {
    requests.push(structuredClone(request));
    return reply;
  };
}

/** What one scripted reply may be: a message, or a function of the request it answers. */
export type Reply =
  | AssistantMessage
  | ((
      context: Context,
      options?: SimpleStreamOptions,
    ) => AssistantMessage | Promise<AssistantMessage>);

/** The marker every child prompt in these tests starts with, so a request can be told apart. */
export const CHILD_MARK = "[child]";

/** Whether a request comes from a child: a user message in it is a child prompt. */
export function isChildRequest(context: Context): boolean {
  return context.messages.some(
    (message) => message.role === "user" && JSON.stringify(message.content).includes(CHILD_MARK),
  );
}

/**
 * Script one faux provider that a parent and its children share. Children run
 * in the background, so the two race for the provider's queue; each reply is
 * therefore chosen by who is asking. A side with nothing scripted answers
 * "(unscripted)". Every request is kept in `requests`, oldest first, which the
 * call empties first, so a second call starts a new phase of the test.
 */
export function scriptSides(
  faux: { setResponses(responses: unknown[]): void },
  replies: { parent?: Reply[]; child?: Reply[] },
  requests: { parent: Context[]; child: Context[] } = { parent: [], child: [] },
) {
  requests.parent.length = 0;
  requests.child.length = 0;
  const queues = { parent: [...(replies.parent ?? [])], child: [...(replies.child ?? [])] };
  const answer = async (context: Context, options?: SimpleStreamOptions) => {
    const side = isChildRequest(context) ? "child" : "parent";
    requests[side].push(structuredClone(context));
    const reply = queues[side].shift();
    if (!reply) return fauxAssistantMessage("(unscripted)");
    return typeof reply === "function" ? reply(context, options) : reply;
  };
  faux.setResponses(Array.from({ length: 60 }, () => answer));
  return { requests, queues };
}

/** A `subagent_start` response for a general-purpose worker whose prompt carries the child marker. */
export const spawnChild = (description: string, extra: Record<string, unknown> = {}) =>
  spawn(description, { prompt: `${CHILD_MARK} ${description}.`, ...extra });
