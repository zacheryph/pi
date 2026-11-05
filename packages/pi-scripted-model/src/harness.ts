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
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  type SessionEntry,
  SessionManager,
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

export interface ScriptedSession {
  session: AgentSession;
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
  /** Errors extensions reported while loading or running. */
  extensionErrors: string[];
  /** Abort, dispose the session, restore the environment and remove temp files. */
  dispose(): Promise<void>;
}

type ExtensionMode = NonNullable<Parameters<AgentSession["bindExtensions"]>[0]["mode"]>;

let open = false;

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
  let session: AgentSession | undefined;
  try {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [options.scenario],
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    for (const { path, error } of resourceLoader.getExtensions().errors) {
      extensionErrors.push(`${path}: ${error}`);
    }

    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
    }));
    const events: AgentSessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    const active = session;
    await active.bindExtensions({
      mode: options.mode ?? "print",
      commandContextActions: {
        waitForIdle: () => active.waitForIdle(),
        newSession: async () => ({ cancelled: true }),
        fork: async () => ({ cancelled: true }),
        navigateTree: async () => ({ cancelled: true }),
        switchSession: async () => ({ cancelled: true }),
        reload: async () => active.reload(),
      },
      onError: (error) => extensionErrors.push(`${error.extensionPath}: ${String(error.error)}`),
    });
    // Extensions register providers when they bind, after the session chose a
    // default model, so select the scripted one now.
    const model = active.modelRuntime.getModel(PROVIDER, MODEL);
    if (!model) throw new Error(`pi-scripted-model: the scenario did not register ${PROVIDER}`);
    await active.setModel(model);
    const real = (await active.modelRuntime.getAllAvailable()).filter(
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

    let disposed = false;
    return {
      session: active,
      cwd,
      agentDir,
      events,
      extensionErrors,
      async prompt(text) {
        await active.prompt(text);
        await active.waitForIdle();
      },
      toolRuns: () => collectToolRuns(active.messages as Message[]),
      entries: (customType) =>
        active.sessionManager
          .getEntries()
          .filter(
            (entry) =>
              customType === undefined ||
              (entry.type === "custom" && entry.customType === customType),
          ),
      async dispose() {
        if (disposed) return;
        disposed = true;
        try {
          await active.abort();
          active.dispose();
        } finally {
          restore();
          rmSync(work, { recursive: true, force: true });
          open = false;
        }
      },
    };
  } catch (error) {
    session?.dispose();
    restore();
    rmSync(work, { recursive: true, force: true });
    open = false;
    throw error;
  }
}
