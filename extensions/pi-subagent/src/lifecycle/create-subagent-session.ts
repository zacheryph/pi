/**
 * create-subagent-session.ts — Assembly factory for born-complete child sessions (issue #265).
 *
 * `createSubagentSession()` does the assembly portion that the old runner's
 * `runAgent()` did up front: detect the environment, assemble the session config,
 * create the SDK session (with the recursion guard as a tool denylist), publish
 * `spawning`/`session-created`, and bind extensions. It returns a fully usable
 * `SubagentSession` — `Subagent` then only coordinates (turn loop, steer, dispose).
 */

import { dirname } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type InlineExtension,
  type SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfigLookup } from "#src/config/agent-types";
import { debugNote } from "#src/debug";
import type { ChildLifecyclePublisher, SubagentHandoff } from "#src/lifecycle/child-lifecycle";
import { ChildWork, type ChildWorkPolicy } from "#src/lifecycle/child-work";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { SubagentSession } from "#src/lifecycle/subagent-session";
import { builtinExtensionsFor } from "#src/session/builtin-extensions";
import { reservedToolsExtension } from "#src/session/reserved-tools";
import type { EnvInfo } from "#src/session/env";
import { resolveToolSelection } from "#src/session/tool-selection";
import type { ModelRegistry } from "#src/session/model-resolver";
import { NotifyParentTool, type UpdateAnnouncer } from "#src/session/notify-parent-tool";
import { provide } from "#session-tree";
import { ensureWorkHost, WORK_PARENT_SERVICE, type WorkParent } from "#work";
import { type AssemblerIO, assembleSessionConfig } from "#src/session/session-config";
import type {
  AgentConfig,
  ParentSessionInfo,
  PromptInheritance,
  ShellExec,
  SubagentType,
  ThinkingLevel,
} from "#src/types";

/**
 * Recursion guard: delegation tools are denied unless the profile declares
 * `delegate: true`; naming them in `tools` does not opt in. The SDK applies the
 * denylist whenever it rebuilds the child's tool registry — including the
 * rebuild triggered by a child extension registering a tool of its own.
 * Filtering the active set once after `bindExtensions` would be undone by that
 * rebuild (#725).
 */
const DELEGATION_TOOL_NAMES = ["subagent_start", "subagent_get", "subagent_send"];

/** pi-ask's tool, which a child with a link to its parent can always call. */
const ASK_TOOL_NAME = "ask";

/**
 * Thrown by `createSubagentSession` when `isStale` says the creation was abandoned: nothing was
 * attached, and the session built so far was discarded without a write to the transcript.
 */
export class StaleSessionError extends Error {
  constructor() {
    super("the child session was abandoned while it was being created");
    this.name = "StaleSessionError";
  }
}

/** Tells the spawner a question the child asked, through the spawner's item for the child. */
export type QuestionAnnouncer = (question: string) => void;

// ── IO boundary ───────────────────────────────────────────────────────────────

/** Minimal resource-loader contract used by the factory. */
export interface ResourceLoaderLike {
  reload(): Promise<void>;
}

/** Minimal session-manager contract used by the factory. */
export interface SessionManagerLike {
  newSession(opts: { parentSession?: string }): void;
  getSessionFile(): string | undefined;
  getSessionId(): string;
  /** The child's own entries: where its work host persists open items. */
  getBranch(): readonly { type: string; customType?: string; data?: unknown }[];
  appendCustomEntry(customType: string, data?: unknown): string;
}

/** Options passed to EnvironmentIO/SessionFactoryIO methods. */
export interface ResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  /** Settings the loader resolves packages from; defaults to the ambient ones when absent. */
  settingsManager?: SettingsManager;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
  systemPromptOverride?: () => string;
  /** Override the append system prompt. Receives the current base value; return the replacement. */
  appendSystemPromptOverride?: (base: string[]) => string[];
  /** Extensions supplied as code; `builtin` entries are Pi's built-ins, resolved as `builtin:<name>`. */
  extensionFactories?: InlineExtension[];
}

/** Options passed to SessionFactoryIO.createSession. */
export interface CreateSessionOptions {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManagerLike;
  settingsManager: SettingsManager;
  modelRegistry: ModelRegistry;
  model?: Model<any>;
  /** Allowlist: only these tool names are enabled in the session. */
  tools: string[];
  /**
   * Tool definitions supplied directly rather than by an extension. The SDK
   * filters these through `tools` too, so every name here must also be listed
   * there or the definition is silently dropped.
   */
  customTools?: ToolDefinition[];
  /** Denylist applied after `tools`, on every tool-registry rebuild. */
  excludeTools?: string[];
  resourceLoader: ResourceLoaderLike;
  thinkingLevel?: ThinkingLevel;
  /** Why the session starts, when it is not a fresh `startup`. */
  sessionStartEvent?: { type: "session_start"; reason: "resume" | "reload" };
}

/**
 * Environment discovery - detect runtime context and resolve directories.
 *
 * Decouples the factory from direct process/SDK reads so each can be stubbed
 * independently in tests.
 */
export interface EnvironmentIO {
  detectEnv: (exec: ShellExec, cwd: string) => Promise<EnvInfo>;
  getAgentDir: () => string;
  deriveSessionDir: (parentSessionFile: string | undefined, effectiveCwd: string) => string;
}

/**
 * Session factory - create SDK objects for a child agent session.
 *
 * Decouples the factory from direct Pi SDK imports and sibling-module IO,
 * making it testable via plain stub objects without vi.mock().
 */
export interface SessionFactoryIO {
  createResourceLoader: (opts: ResourceLoaderOptions) => ResourceLoaderLike;
  createSessionManager: (cwd: string, sessionDir: string) => SessionManagerLike;
  /** Reopen a saved transcript, which further entries then append to. */
  openSessionManager: (path: string, cwd: string) => SessionManagerLike;
  createSettingsManager: (cwd: string, agentDir: string) => SettingsManager;
  /**
   * Settings view the child's resource loader resolves packages from.
   * The composition root decides whether any package extensions are excluded;
   * the identity function reproduces the child's default full inheritance.
   */
  createLoaderSettingsManager: (parent: SettingsManager) => SettingsManager;
  createSession: (opts: CreateSessionOptions) => Promise<{ session: AgentSession }>;
  assemblerIO: AssemblerIO;
}

/**
 * IO boundary injected into createSubagentSession().
 *
 * Intersection of EnvironmentIO and SessionFactoryIO — callers satisfy both
 * sub-interfaces via TypeScript's structural typing.
 */
export type SubagentSessionIO = EnvironmentIO & SessionFactoryIO;

/**
 * Dependencies injected at construction time — the IO boundary plus the two
 * static domain deps (exec, registry) every creation needs.
 */
export interface SubagentSessionDeps {
  io: SubagentSessionIO;
  exec: ShellExec;
  registry: AgentConfigLookup;
  /** Publishes the child-execution lifecycle so consumers can observe it. */
  lifecycle: ChildLifecyclePublisher;
  /**
   * Which prompt-inheritance strategy a child on the given provider adopts.
   *
   * Resolved at the composition root from the operator's settings, so this
   * factory stays policy-free — the same shape the extension-exclusion policy
   * reaches it in.
   */
  resolvePromptInheritance: (provider: string | undefined) => PromptInheritance;
  /**
   * Names of the tools the parent session has registered, read when a child is
   * created. An agent's `mcp__<server>__*` tool patterns expand against them.
   */
  listParentToolNames: () => readonly string[];
}

/** Per-spawn parameters — the fields that vary per child session. */
export interface CreateSubagentSessionParams {
  snapshot: ParentSnapshot;
  type: SubagentType;
  /** Composed config from the spawn boundary; no fragment IO occurs here. */
  agentConfig?: AgentConfig;
  /** The directory the child runs in; undefined → parent cwd. */
  cwd?: string;
  /** Parent session identity (file path + session ID). */
  parentSession?: ParentSessionInfo;
  /** The subagent record id, carried on this session's lifecycle events. */
  agentId?: string;
  /** Forwarded untouched on `session-created`. */
  handoff?: SubagentHandoff;
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  /**
   * Tells the spawner a question the child asks with pi-ask's `ask` tool. Supplied for every
   * child; it is offered as the child's `work:parent` service, which turns `ask` toward this
   * parent: pi-ask opens a question item in the child's own work host (the child then waits on
   * it) and calls this once. Its absence leaves the child without a parent to ask.
   */
  announceQuestion?: QuestionAnnouncer;
  /**
   * What the child's work host asks of its agent. Supplied for every child a `Subagent` creates:
   * the child's session then gets a managed `work:v1` host under its session id before its
   * extensions bind, so nothing the child waits on can start a run of its own. Absent only for a
   * session built outside a `Subagent`, which then gets the root host from `ensureWorkHost`.
   */
  work?: ChildWorkPolicy;
  /**
   * Announces a mid-run update the child sends with `parent_notify`. Supplied
   * only for a background child whose operator left the channel on; its absence
   * installs no update tool.
   */
  notifyParent?: UpdateAnnouncer;
  /**
   * The transcript to continue instead of starting a new one (a cold resume).
   * Its messages are the child's history, so `snapshot.parentContext` is unused.
   */
  transcriptPath?: string;
  /**
   * Whether this creation has been abandoned (a reopen the caller gave up on after a bound, or a
   * manager that shut down meanwhile). Read at the points where the creation would touch what
   * another session may own by then: once the transcript's session is built and once the child's
   * extensions have started, where it also guards the host's every write. When it says yes the
   * session is discarded without writing to the transcript or publishing `disposed`, and the call
   * throws `StaleSessionError`. Without it, a creation that hangs and then completes would settle
   * its startup against a transcript a newer session has been appending to since.
   */
  isStale?: () => boolean;
  /**
   * Why a reopened transcript's session starts, which its extensions see as `session_start`'s
   * reason. `resume` (the default) is any reopen; `reload` is the spawning session reloading, the
   * only reason pi-job takes its retained jobs back for (roadmap step 12). Needs `transcriptPath`.
   */
  startReason?: "resume" | "reload";
}

/**
 * The core's own child-facing tools, built for whichever callbacks this run
 * supplied. An agent's `tools:` list is its complete capability allowlist, so
 * these are appended to it rather than drawn from it: they are protocol the
 * core installs in every child, and neither reaches the filesystem, the shell,
 * or the network.
 */
function buildChildTools(params: CreateSubagentSessionParams): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (params.notifyParent) tools.push(new NotifyParentTool(params.notifyParent).toToolDefinition());
  return tools;
}

/**
 * Inline extension of every managed child: `ensureWorkHost` forwards the session's run boundaries
 * (`agent_before_settle` above all, which only an extension can answer) to the host offered under
 * its id. It reads no landing: that is the host's own tracker (`ChildWork`).
 */
function wireWorkHost(pi: Parameters<typeof ensureWorkHost>[0]): void {
  ensureWorkHost(pi);
}

/**
 * Build a born-complete SubagentSession: assemble config, create the SDK
 * session, publish lifecycle events, bind extensions, apply the recursion guard.
 */
export async function createSubagentSession(
  params: CreateSubagentSessionParams,
  deps: SubagentSessionDeps,
): Promise<SubagentSession> {
  const { snapshot, type } = params;
  const parentSessionId = params.parentSession?.parentSessionId;
  deps.lifecycle.spawning({ agentName: type, parentSessionId });

  // Resolve working directory upfront - needed for detectEnv before assembly.
  const effectiveCwd = params.cwd ?? snapshot.cwd;
  const env = await deps.io.detectEnv(deps.exec, effectiveCwd);

  // Assemble session configuration (synchronous, no SDK objects).
  const cfg = assembleSessionConfig(
    type,
    {
      cwd: snapshot.cwd,
      parentSystemPrompt: snapshot.systemPrompt,
      parentPortablePrompt: snapshot.portablePrompt,
      parentModel: snapshot.model,
      modelRegistry: snapshot.modelRegistry,
      resolvePromptInheritance: deps.resolvePromptInheritance,
    },
    {
      agentConfig: params.agentConfig,
      cwd: params.cwd,
      model: params.model,
      thinkingLevel: params.thinkingLevel,
    },
    env,
    deps.registry,
    deps.io.assemblerIO,
  );

  const run = {
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.parentSession?.toolCallId !== undefined
      ? { toolCallId: params.parentSession.toolCallId }
      : {}),
  };
  const requiredTools = deps.lifecycle.prepare({
    agentName: type,
    parentSessionId,
    ...run,
    ...(params.handoff ? { handoff: params.handoff } : {}),
    cwd: cfg.effectiveCwd,
  });
  // Handoff owners may add capabilities omitted by a profile, never override an
  // explicit exclusion. Resolve their literal names too so MCP exclusions apply.
  const selection = resolveToolSelection(cfg.toolNames, [
    ...new Set([...deps.listParentToolNames(), ...requiredTools]),
  ]);
  const { unmatchedPatterns } = selection;
  // `delegate: true` adds the delegation tools; a `-subagent_*` exclusion still
  // wins. Without it they are stripped whatever `tools` selected.
  const delegationTools = cfg.delegate
    ? DELEGATION_TOOL_NAMES.filter((name) => !selection.excludedToolNames.includes(name))
    : [];
  const deniedRequired = requiredTools.filter(
    (name) =>
      selection.excludedToolNames.includes(name) ||
      (DELEGATION_TOOL_NAMES.includes(name) && !delegationTools.includes(name)),
  );
  if (deniedRequired.length)
    throw new Error(
      `Cannot prepare subagent ${type}: required tools excluded: ${deniedRequired.join(", ")}`,
    );
  const toolNames = [
    ...new Set([...selection.toolNames, ...requiredTools, ...delegationTools]),
  ].filter((name) => !DELEGATION_TOOL_NAMES.includes(name) || delegationTools.includes(name));
  for (const pattern of unmatchedPatterns) {
    debugNote(`agent ${type}: tools pattern ${pattern} matched no tool the parent has`);
  }

  const agentDir = deps.io.getAgentDir();
  const sessionSettings = deps.io.createSettingsManager(cfg.effectiveCwd, agentDir);
  const loaderSettings = deps.io.createLoaderSettingsManager(sessionSettings);

  // Children inherit the parent's skills and every extension the composition
  // root did not exclude (#696), plus the Pi built-ins their tools call for —
  // Pi supplies those to its own CLI session only.
  //
  // Suppress AGENTS.md/CLAUDE.md and APPEND_SYSTEM.md - upstream's
  // buildSystemPrompt() re-appends both AFTER systemPromptOverride, which
  // would defeat prompt_mode: replace. Parent context, if wanted, reaches the
  // subagent via prompt_mode: append (parentSystemPrompt is embedded in
  // systemPromptOverride) or inherit_context (conversation).
  const loader = deps.io.createResourceLoader({
    cwd: cfg.effectiveCwd,
    agentDir,
    settingsManager: loaderSettings,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => cfg.systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionFactories: [
      ...builtinExtensionsFor(toolNames),
      // Reserved tools stay in the child's allowlist, so its own workers can still be
      // given them; only the child's own calls are refused.
      ...(cfg.reservedTools?.length ? [reservedToolsExtension(type, cfg.reservedTools)] : []),
      // The child's session reports its run boundaries to its managed host through this
      // extension, whichever of the operator's extensions the child loads (or excludes).
      ...(params.work ? [wireWorkHost] : []),
    ],
  });
  await loader.reload();
  if (params.isStale?.()) throw new StaleSessionError();

  // Create a persisted SessionManager so transcripts are written in Pi's
  // official JSONL format. Falls back to a temp directory when the parent
  // session is not persisted (e.g. headless/API mode). A cold resume reopens the
  // transcript where it is: the parent may have moved or forked since it was made.
  const { transcriptPath } = params;
  const sessionDir = transcriptPath
    ? dirname(transcriptPath)
    : deps.io.deriveSessionDir(params.parentSession?.parentSessionFile, cfg.effectiveCwd);
  const sessionManager = transcriptPath
    ? deps.io.openSessionManager(transcriptPath, cfg.effectiveCwd)
    : deps.io.createSessionManager(cfg.effectiveCwd, sessionDir);
  if (!transcriptPath) {
    sessionManager.newSession({ parentSession: params.parentSession?.parentSessionId });
  }
  const sessionId = sessionManager.getSessionId();

  const childTools = buildChildTools(params);
  // pi-ask's `ask` is protocol like the core's own child tools: a child with a
  // route to its parent can always ask, whatever its tools: allowlist says.
  const protocolTools = [
    ...(params.announceQuestion ? [ASK_TOOL_NAME] : []),
    ...childTools.map((tool) => tool.name),
  ];
  const { session } = await deps.io.createSession({
    cwd: cfg.effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager: sessionSettings,
    modelRegistry: snapshot.modelRegistry,
    model: cfg.model,
    tools: [...new Set([...toolNames, ...protocolTools])],
    customTools: childTools,
    excludeTools: DELEGATION_TOOL_NAMES.filter((name) => !delegationTools.includes(name)),
    resourceLoader: loader,
    thinkingLevel: cfg.thinkingLevel,
    ...(transcriptPath
      ? {
          sessionStartEvent: {
            type: "session_start" as const,
            reason: params.startReason ?? ("resume" as const),
          },
        }
      : {}),
  });

  if (params.isStale?.()) {
    // Before anything is offered under the session id, which a newer session may now hold.
    session.dispose();
    throw new StaleSessionError();
  }

  // Offered before the child's extensions bind, so pi-ask finds it on session_start.
  const announceQuestion = params.announceQuestion;
  const withdrawParentLink = announceQuestion
    ? provide(sessionId, WORK_PARENT_SERVICE, {
        question: (question: string) => announceQuestion(question),
      } satisfies WorkParent)
    : undefined;
  // The managed work host, offered the same way: `ensureWorkHost` in the child finds it, provides
  // nothing, and only forwards the child's run boundaries to it.
  const work = params.work
    ? new ChildWork({
        sessionId,
        session,
        store: sessionManager,
        policy: params.work,
        ...(params.isStale ? { isStale: params.isStale } : {}),
      })
    : undefined;
  const subagentSession = new SubagentSession(session, {
    outputFile: sessionManager.getSessionFile(),
    sessionId,
    ...run,
    sessionDir,
    agentName: type,
    agentMaxTurns: cfg.agentMaxTurns,
    parentContext: snapshot.parentContext,
    lifecycle: deps.lifecycle,
    ...(work ? { work } : {}),
    ...(withdrawParentLink ? { onDispose: withdrawParentLink } : {}),
  });

  // Publish session-created before bindExtensions() so observers (e.g. the
  // permission system) can register the child synchronously and have their
  // entry in place for the first permission check during child extension
  // initialization. The event bus dispatches synchronously, so a synchronous
  // subscriber completes before this returns.
  deps.lifecycle.sessionCreated({
    sessionId,
    parentSessionId,
    ...run,
    ...(params.handoff ? { handoff: params.handoff } : {}),
    cwd: cfg.effectiveCwd,
  });

  try {
    // Bind extensions so that session_start fires and extensions can initialize.
    await session.bindExtensions({});
    // Whatever kept the extensions from starting is over, but the agent may have been given up on
    // meanwhile: its transcript then belongs to a newer session, so nothing is settled against it.
    if (params.isStale?.()) throw new StaleSessionError();
    // Each extension has had its `session_start` and its chance to adopt what an earlier
    // instance of this child left open: whatever nobody took is reported lost.
    work?.settleStartup();
    const activeTools = new Set(session.getActiveToolNames());
    const missing = requiredTools.filter((name) => !activeTools.has(name));
    if (missing.length)
      throw new Error(
        `Cannot prepare subagent ${type}: required tools unavailable: ${missing.join(", ")}`,
      );
  } catch (err) {
    // Initialization failed after session-created — dispose (child session_shutdown +
    // session.dispose() + emit disposed) before rethrowing so neither the
    // registration nor a partially-initialized extension's resources leak.
    await subagentSession.dispose("quit", !(err instanceof StaleSessionError));
    throw err;
  }

  // Every child session_start handler has now run, so this is the first — and
  // only — moment a parent can observe what the child's extensions installed.
  // Deliberately outside the try above: a child whose binding threw never ran.
  deps.lifecycle.bound({ sessionId, parentSessionId, ...run });

  return subagentSession;
}
