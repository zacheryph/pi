/**
 * In-process test harness: the real bundle, a scripted model, no API key.
 *
 * `startSession` loads this repository's root package exactly as a personal
 * install would (every extension and skill in the manifest), adds a scenario
 * from `./scenario.ts` as the model, and binds the session the way Pi's print
 * mode does. Tests then `prompt` it and inspect tool results, session entries
 * and events. Subagents work too: pi-subagent hands the scripted provider down
 * to each child session, and the scenario answers children by their prompt.
 *
 * The session is saved to a file, as a real one is, so tests can also compact
 * it and resume it, and every request the model receives is recorded with the
 * context messages extensions added to it.
 *
 * Everything runs in a throwaway directory: HOME, the agent directory, TMPDIR
 * and, unless `cwd` is given, the working directory. Settings, sessions, stashes
 * and job logs never touch the real `~/.pi/agent`. No real provider is
 * reachable: credential-like environment variables (API keys, tokens, cloud
 * credentials) are removed while the session is open, the agent directory has
 * no auth.json, and `startSession` throws if any model other than the scripted
 * ones is available.
 *
 * The harness sets process-wide environment variables while a session is open,
 * so only one session may be open per process at a time (vitest runs each test
 * file in its own worker, so files may run in parallel).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentSession,
  type AgentSessionEvent,
  type CompactionResult,
  type ContextEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  type SessionEntry,
  SessionManager,
  type SessionStartEvent,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ENABLE_ENV, MODEL, PROVIDER } from "./scenario.ts";

/** The repository root: the package a session loads as its bundle. */
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface SessionOptions {
  /** The model: a scenario built with `defineScenario`. */
  scenario: ExtensionFactory;
  /** Working directory. Default: a fresh empty directory, removed on dispose. */
  cwd?: string;
  /**
   * Files to write into the agent directory before loading, such as extension
   * settings: `{ "todo.json": { ... } }`. Objects are written as JSON.
   */
  agentFiles?: Record<string, string | object>;
  /** Load this repository's bundle. Default true; false loads only the scenario. */
  bundle?: boolean;
  /** Extension mode reported to extensions. Default "print". */
  mode?: ExtensionMode;
  /** Pi settings merged into the agent directory's `settings.json`, e.g. `{ compaction: … }`. */
  settings?: Record<string, unknown>;
}

export interface ToolRun {
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  /** The result's text content, joined. */
  text: string;
  /** The result's `details`, as the tool returned them. */
  details: unknown;
}

/** A message as the model receives it, before Pi converts it for the provider. */
export type ContextMessage = ContextEvent["messages"][number];

/** One request to the model from the main session. */
export interface ModelRequest {
  /**
   * The messages sent, after every extension's `context` handler ran. Context
   * cards keep their `role: "custom"` and `customType` here; the provider sees
   * them as user messages.
   */
  messages: ContextMessage[];
}

export interface ScriptedSession {
  /** The current session. `resume` replaces it. */
  readonly session: AgentSession;
  cwd: string;
  agentDir: string;
  /** Every event the session emitted, in order. */
  events: AgentSessionEvent[];
  /** Send a user prompt and wait until the session is idle again. */
  prompt(text: string): Promise<void>;
  /** Tool calls the main session ran, with their results, in order. */
  toolRuns(): ToolRun[];
  /** Session entries, optionally only custom entries of one `customType`. */
  entries(customType?: string): SessionEntry[];
  /** Model requests from the main session (not subagents), oldest first, across resumes. */
  requests(): ModelRequest[];
  /** Compact the session now, as `/compact` does. The scenario answers the summary request. */
  compact(): Promise<CompactionResult>;
  /**
   * Shut the session down and reopen its file in a new one, as `/resume` does:
   * extensions see `session_shutdown`, then `session_start` with reason "resume".
   */
  resume(): Promise<void>;
  /** Errors extensions reported while loading or running. */
  extensionErrors: string[];
  /**
   * Abort, end the session with `session_shutdown` as quitting does, restore the
   * environment and remove temp files.
   */
  dispose(): Promise<void>;
}

type ExtensionMode = NonNullable<Parameters<AgentSession["bindExtensions"]>[0]["mode"]>;

let open = false;

/**
 * Records each main-session request. Loaded after the bundle and the scenario,
 * so its `context` handler runs last and sees every card the bundle added.
 * Subagents do not load it: pi-subagent builds their resources itself.
 */
function recorder(requests: ModelRequest[]): ExtensionFactory {
  return (pi) => {
    pi.on("context", (event) => {
      requests.push({ messages: structuredClone(event.messages) });
    });
  };
}

/**
 * Environment variables removed while a session is open, so no real provider
 * (or GitHub, or a cloud SDK) can authenticate from inside a test.
 */
export const CREDENTIAL_ENV =
  /(API_KEY|_TOKEN|TOKEN_FILE|SECRET|PASSWORD|ACCESS_KEY|^AWS_|^ANTHROPIC_|^OPENAI_|^GOOGLE_|^GEMINI_|^AZURE_|^VERTEX|BEDROCK|^CLOUDSDK_|^GCLOUD|^MISTRAL_|^GROQ_|^XAI_|^OPENROUTER_|^DEEPSEEK_|^CEREBRAS_|^HF_|^GH_|^GITHUB_)/i;

type Block = { type: string; text?: string; id?: string; name?: string; arguments?: unknown };
type Message = {
  role: string;
  content?: unknown;
  toolCallId?: string;
  isError?: boolean;
  details?: unknown;
};

function blocks(message: Message): Block[] {
  return Array.isArray(message.content) ? (message.content as Block[]) : [];
}

/** Pair each assistant tool call with its tool result message. */
export function collectToolRuns(messages: readonly Message[]): ToolRun[] {
  const results = new Map<string, Message>();
  for (const message of messages) {
    if (message.role === "toolResult" && message.toolCallId) {
      results.set(message.toolCallId, message);
    }
  }
  const runs: ToolRun[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of blocks(message)) {
      if (block.type !== "toolCall" || !block.id) continue;
      const result = results.get(block.id);
      runs.push({
        name: block.name ?? "",
        args: (block.arguments ?? {}) as Record<string, unknown>,
        isError: result?.isError ?? false,
        text: result
          ? blocks(result)
              .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
              .join("")
          : "",
        details: result?.details,
      });
    }
  }
  return runs;
}

export async function startSession(options: SessionOptions): Promise<ScriptedSession> {
  if (open) throw new Error("pi-scripted-model: only one session may be open per process");
  open = true;

  const work = realpathSync(mkdtempSync(join(tmpdir(), "pi-scripted-")));
  const agentDir = join(work, "agent");
  const tmp = join(work, "tmp");
  const cwd = options.cwd ? realpathSync(resolve(options.cwd)) : join(work, "cwd");
  mkdirSync(agentDir);
  mkdirSync(tmp);
  if (!options.cwd) mkdirSync(cwd);
  // Settings live on disk, as in a real install: pi-subagent builds each child's
  // resources from the agent directory, so children load the same bundle.
  const settings = {
    // Keep no recent turns, so `compact()` has something to summarize in a
    // scripted session of a few short turns.
    compaction: { keepRecentTokens: 1 },
    ...options.settings,
    packages: options.bundle === false ? [] : [REPOSITORY_ROOT],
    defaultProvider: PROVIDER,
    defaultModel: MODEL,
  };
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
  for (const [name, content] of Object.entries(options.agentFiles ?? {})) {
    writeFileSync(
      join(agentDir, name),
      typeof content === "string" ? content : JSON.stringify(content, null, 2),
    );
  }

  const home = join(work, "home");
  mkdirSync(home);
  const saved = new Map<string, string | undefined>();
  const setEnv = (name: string, value: string | undefined) => {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  for (const name of Object.keys(process.env)) {
    if (CREDENTIAL_ENV.test(name)) setEnv(name, undefined);
  }
  setEnv("HOME", home);
  setEnv(ENABLE_ENV, "1");
  setEnv("PI_CODING_AGENT_DIR", agentDir);
  setEnv("PI_OFFLINE", "1");
  setEnv("TMPDIR", tmp);
  const restore = () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  const extensionErrors: string[] = [];
  const events: AgentSessionEvent[] = [];
  const requests: ModelRequest[] = [];
  const sessionDir = join(agentDir, "sessions");
  const settingsManager = SettingsManager.create(cwd, agentDir);

  /** Load the bundle and bind a session on `sessionManager`, as Pi's print mode does. */
  const load = async (sessionManager: SessionManager, sessionStartEvent?: SessionStartEvent) => {
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [options.scenario, recorder(requests)],
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    for (const { path, error } of resourceLoader.getExtensions().errors) {
      extensionErrors.push(`${path}: ${error}`);
    }
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      settingsManager,
      sessionManager,
      ...(sessionStartEvent ? { sessionStartEvent } : {}),
    });
    try {
      session.subscribe((event) => events.push(event));
      await session.bindExtensions({
        mode: options.mode ?? "print",
        commandContextActions: {
          waitForIdle: () => session.waitForIdle(),
          newSession: async () => ({ cancelled: true }),
          fork: async () => ({ cancelled: true }),
          navigateTree: async () => ({ cancelled: true }),
          switchSession: async () => ({ cancelled: true }),
          reload: async () => session.reload(),
        },
        onError: (error) => extensionErrors.push(`${error.extensionPath}: ${String(error.error)}`),
      });
      // Extensions register providers when they bind, after the session chose a
      // default model, so select the scripted one now.
      const model = session.modelRuntime.getModel(PROVIDER, MODEL);
      if (!model) throw new Error(`pi-scripted-model: the scenario did not register ${PROVIDER}`);
      await session.setModel(model);
      const real = (await session.modelRuntime.getAllAvailable()).filter(
        (available) => available.provider !== PROVIDER,
      );
      if (real.length > 0) {
        throw new Error(
          `pi-scripted-model: real models are available, refusing to run: ${real
            .map((m) => `${m.provider}/${m.id}`)
            .slice(0, 5)
            .join(", ")}`,
        );
      }
      return session;
    } catch (error) {
      session.dispose();
      throw error;
    }
  };

  /** Settle the session and tell extensions it ends, as Pi does before replacing or quitting. */
  const shutDown = async (session: AgentSession, reason: "quit" | "resume") => {
    try {
      await session.abort();
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason,
        ...(reason === "resume" ? { targetSessionFile: session.sessionFile } : {}),
      });
    } finally {
      session.dispose();
    }
  };

  let current: AgentSession;
  try {
    current = await load(SessionManager.create(cwd, sessionDir));
  } catch (error) {
    restore();
    rmSync(work, { recursive: true, force: true });
    open = false;
    throw error;
  }

  let disposed = false;
  return {
    get session() {
      return current;
    },
    cwd,
    agentDir,
    events,
    extensionErrors,
    async prompt(text) {
      await current.prompt(text);
      await current.waitForIdle();
    },
    toolRuns: () => collectToolRuns(current.messages as Message[]),
    entries: (customType) =>
      current.sessionManager
        .getEntries()
        .filter(
          (entry) =>
            customType === undefined ||
            (entry.type === "custom" && entry.customType === customType),
        ),
    requests: () => [...requests],
    compact: () => current.compact(),
    async resume() {
      const file = current.sessionFile;
      if (!file) throw new Error("pi-scripted-model: the session has no file to resume");
      await shutDown(current, "resume");
      current = await load(SessionManager.open(file, sessionDir, cwd), {
        type: "session_start",
        reason: "resume",
        previousSessionFile: file,
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await shutDown(current, "quit");
      } finally {
        restore();
        rmSync(work, { recursive: true, force: true });
        open = false;
      }
    },
  };
}
