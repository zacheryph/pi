/**
 * pi-subagent — focused, in-process autonomous sub-agents.
 *
 * Tools: subagent_start, subagent_get, subagent_send.
 * Commands: /subagent:watch, /subagent:settings, /subagent:agents, /subagent:sessions.
 */

import { readFileSync } from "node:fs";
import { userOutput } from "#foundations/user-output";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  loadProjectContextFiles,
  ModelRuntime,
  type ResourceLoader,
  ModelRegistry as SdkModelRegistry,
  SettingsManager as SdkSettingsManager,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { debugLog } from "#src/debug";
import { loadCustomAgents } from "#src/config/custom-agents";
import { InterruptHandler } from "#src/handlers/interrupt";
import { SessionLifecycleHandler } from "#src/handlers/lifecycle";
import { StartupRestore } from "#src/handlers/restore";
import { WidgetEventsHandler } from "#src/handlers/widget-events";
import { registerRosterCard } from "#src/handlers/roster-card";
import { createChildLifecyclePublisher } from "#src/lifecycle/child-lifecycle";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import {
  createSubagentSession,
  type SubagentSessionDeps,
} from "#src/lifecycle/create-subagent-session";
import { SubagentManager } from "#src/lifecycle/subagent-manager";
import { transcriptWork } from "#src/lifecycle/transcript-work";
import { CompositeSubagentObserver } from "#src/observation/composite-subagent-observer";
import type {
  NotificationDetails,
  QuestionDetails,
  UpdateDetails,
} from "#src/observation/notification";
import {
  createNotificationRenderer,
  createQuestionRenderer,
  createUpdateRenderer,
} from "#src/observation/renderer";
import { SubagentEventsObserver } from "#src/observation/subagent-events-observer";
import { buildSubagentSnapshot, SUBAGENT_SNAPSHOT } from "#src/observation/snapshot";
import { SubagentWork } from "#src/observation/subagent-work";
import { registerMainAgentProfile } from "#src/main-agent-profile";
import { SUBAGENT_RECORD_ENTRY } from "#src/persisted-record";
import { SubagentRuntime } from "#src/runtime";
import { readBranchRecords } from "#src/roster";
import { detectEnv } from "#src/session/env";
import { createExcludedPackagesStorage } from "#src/session/package-exclusions";
import { createProjectContextLoader } from "#src/session/project-context";
import { buildAgentPrompt } from "#src/session/prompts";
import { inheritRegisteredProviders } from "#src/session/provider-inheritance";
import { deriveSubagentSessionDir } from "#src/session/session-dir";
import { SettingsManager } from "#src/settings";
import { AgentTool } from "#src/tools/agent-tool";
import { GetResultTool } from "#src/tools/get-result-tool";
import { SendTool } from "#src/tools/send-tool";
import { AgentWidget } from "#src/ui/agent-widget";
import { agentsListText, showAgentsBrowser } from "#src/ui/agents-browser";
import { SessionNavigatorHandler } from "#src/ui/session-navigator";
import { SubagentsSettingsHandler } from "#src/ui/subagents-settings";
import { WatchOverlay } from "#src/ui/watch-overlay";
import { service } from "#session-tree";
import { ensureWorkHost, WORK_PARENT_SERVICE } from "#work";

export default function (pi: ExtensionAPI) {
  // Command results: a notification in the terminal, a displayed message elsewhere.
  const output = userOutput(pi, "subagent:output");
  // ---- Register custom notification renderer ----
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent:completion",
    createNotificationRenderer(),
  );
  pi.registerMessageRenderer<UpdateDetails>("subagent:update", createUpdateRenderer());
  pi.registerMessageRenderer<QuestionDetails>("subagent:question", createQuestionRenderer());

  const registry = new AgentTypeRegistry(() => loadCustomAgents(process.cwd()));

  // ---- Runtime: all mutable extension state in one place ----
  const runtime = new SubagentRuntime();

  // ---- Work: the session that spawns an agent waits on its runs ----
  // Each run is an item in the spawning session's work host (packages/pi-work), completed with
  // the completion message. The host writes the message into the transcript, wakes an idle
  // session, and answers it in the same run when the session is running; this extension holds
  // and queues nothing. Called first, so the host's session handlers are registered before ours.
  const workAccess = ensureWorkHost(pi);
  const work = new SubagentWork(() => workAccess.host());

  // Settings: owns all three in-memory values and handles load/save/emit.
  // onMaxConcurrentChanged is wired to the limiter directly (closure captures by reference).
  const settings = new SettingsManager({
    emit: (event, payload) => pi.events.emit(event, payload),
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    onMaxConcurrentChanged: () => limiter.recheck(),
  });
  settings.load();

  // Observer: receives agent lifecycle notifications and dispatches events/notifications.
  const eventsObserver = new SubagentEventsObserver({
    emit: (channel, data) => pi.events.emit(channel, data),
    appendEntry: (customType, data) => pi.appendEntry(customType, data),
    work,
    changed: () => publishSnapshot(),
    isOnBranch: (id) =>
      readBranchRecords(runtime.currentCtx)?.some((record) => record.id === id) ?? false,
  });

  // Fan-out observer: lets the widget subscribe as a second lifecycle consumer
  // while the manager keeps its single-observer contract. The widget is added
  // after construction (it needs the manager); the manager consults the observer
  // only at spawn time, so registering late is safe.
  const observer = new CompositeSubagentObserver([eventsObserver]);

  const subagentSessionDeps: SubagentSessionDeps = {
    io: {
      detectEnv,
      getAgentDir,
      createResourceLoader: (opts) => new DefaultResourceLoader(opts),
      deriveSessionDir: deriveSubagentSessionDir,
      createSessionManager: (cwd, dir) => SessionManager.create(cwd, dir),
      openSessionManager: (path, cwd) => SessionManager.open(path, undefined, cwd),
      createSettingsManager: (cwd, dir) => SdkSettingsManager.create(cwd, dir),
      // The exclusion policy is resolved here, at the composition root, so the
      // assembly factory stays free of it and gets a ready-made settings view.
      createLoaderSettingsManager: (parent) => {
        const excluded = new Set(settings.excludedExtensionPackages);
        if (excluded.size === 0) return parent;
        return SdkSettingsManager.fromStorage(createExcludedPackagesStorage(parent, excluded), {
          projectTrusted: parent.isProjectTrusted(),
        });
      },
      // The factory states its collaborators as narrow structural contracts so
      // it can be tested with plain stubs. Here at the composition root the
      // values really are the SDK objects, so widen those three and let every
      // other option type-check against the SDK signature.
      createSession: async ({ sessionManager, resourceLoader, modelRegistry, ...rest }) => {
        // Pi builds the child a fresh ModelRuntime whenever it is not given
        // one, and runtime registrations live on the instance rather than in
        // models.json or auth.json — so the child would lose every provider the
        // parent registered via pi.registerProvider. Build the runtime here
        // instead and replay those registrations onto it. The child keeps its
        // own pool, so a child-loaded extension cannot mutate the parent's
        // (Refs #812). The path derivation mirrors the SDK's own.
        const childRuntime = await ModelRuntime.create({
          authPath: join(rest.agentDir, "auth.json"),
          modelsPath: join(rest.agentDir, "models.json"),
        });
        const childRegistry = new SdkModelRegistry(childRuntime);
        inheritRegisteredProviders(modelRegistry as SdkModelRegistry, {
          registerNative: (provider) => {
            childRegistry.registerProvider(provider);
          },
          registerConfigured: (id, config) => {
            childRegistry.registerProvider(id, config);
          },
        });
        return createAgentSession({
          ...rest,
          sessionManager: sessionManager as SessionManager,
          resourceLoader: resourceLoader as ResourceLoader,
          modelRuntime: childRuntime,
        });
      },
      assemblerIO: {
        buildAgentPrompt,
        // Pi's own discovery, pointed at whichever directory the child runs in.
        loadProjectContext: createProjectContextLoader(loadProjectContextFiles, getAgentDir()),
      },
    },
    exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
    registry,
    lifecycle: createChildLifecyclePublisher((channel, data) => pi.events.emit(channel, data)),
    // Resolved here, at the composition root, so the assembly factory stays
    // free of the policy and gets a ready-made settings view — the same shape
    // the extension-exclusion policy reaches it in. It is a resolver rather
    // than a value because only the assembler knows the child's provider.
    resolvePromptInheritance: (provider) => settings.promptInheritanceFor(provider),
    // Read per child rather than once: an MCP server connects in the
    // background, so its tools register after this extension loads.
    listParentToolNames: () =>
      pi
        .getAllTools()
        .filter((tool) => tool.exposure !== "hidden")
        .map((tool) => tool.name),
  };

  // ConcurrencyLimiter: schedules background run thunks FIFO against the limit.
  // It knows nothing about agents or the manager — dependency direction is strictly manager → limiter.
  const limiter = new ConcurrencyLimiter(() => settings.maxConcurrent);

  const manager = new SubagentManager({
    createSubagentSession: (params) => createSubagentSession(params, subagentSessionDeps),
    observer,
    limiter,
    getRunConfig: () => settings,
    getRetentionPolicy: () => settings,
    registry,
    savedAgents: {
      find: (id) => readBranchRecords(runtime.currentCtx)?.find((record) => record.id === id),
      parent: () => ({
        snapshot: runtime.buildSnapshot(false),
        parentSession: runtime.getSessionInfo(),
      }),
      persist: (record) => pi.appendEntry(SUBAGENT_RECORD_ENTRY, record),
    },
    // A transcript no live session holds is read and settled with Pi's own session manager.
    transcripts: transcriptWork((path) => SessionManager.open(path)),
  });

  const publishSnapshot = () => {
    if (!runtime.currentCtx) return;
    pi.events.emit(
      SUBAGENT_SNAPSHOT,
      buildSubagentSnapshot(readBranchRecords(runtime.currentCtx) ?? [], (id) =>
        manager.getRecord(id),
      ),
    );
  };

  // A delegated session has a delegator above it, which offers `work:parent` under its id before
  // its extensions bind. Its own subagents end with it, so it restores none (see StartupRestore).
  const isDelegated = (ctx: unknown) => {
    try {
      const id = (
        ctx as { sessionManager?: { getSessionId(): string } } | undefined
      )?.sessionManager?.getSessionId();
      return id !== undefined && service(id, WORK_PARENT_SERVICE) !== undefined;
    } catch {
      return false; // a stale context says nothing: not a delegated session we can tell
    }
  };
  const lifecycle = new SessionLifecycleHandler(
    runtime,
    manager,
    () => work.dispose(),
    () => isDelegated(runtime.currentCtx),
  );
  const startupRestore = new StartupRestore({
    manager,
    work,
    readRecords: (ctx) => readBranchRecords(ctx),
    isChild: isDelegated,
    // Written into the transcript, never a turn: lost work wakes nothing.
    report: (message) => {
      try {
        pi.sendMessage(
          {
            customType: message.customType,
            content: message.content,
            display: true,
            ...(message.details !== undefined ? { details: message.details } : {}),
          },
          { triggerTurn: false },
        );
      } catch (err) {
        // The session was shut down while its agents were being restored: nobody is left to tell.
        debugLog("report lost work", err);
      }
    },
  });

  // Live widget: constructed after the manager (it polls listAgents()) and
  // registered as a lifecycle observer so it self-drives its update timer.
  const widget = new AgentWidget(manager, registry);
  observer.add(widget);

  const watch = new WatchOverlay(manager, registry, settings);
  observer.add(watch);
  const unsubscribeWatchSettings = pi.events.on("subagent:settings:changed", () =>
    watch.settingsChanged(),
  );

  // Give the widget its UI context and its turn ticks. Pi fans an event out to
  // every handler an extension registers for it, so these take their own
  // registrations rather than sharing a lambda with an unrelated concern.
  const widgetEvents = new WidgetEventsHandler(widget);

  pi.on("session_start", (event, ctx) => lifecycle.handleSessionStart(event, ctx));
  pi.on("session_start", (event, ctx) => widgetEvents.handleSessionStart(event, ctx));
  pi.on("session_start", (_event, ctx) => watch.setContext(ctx));
  // Restore the branch's agents to the model's context after it may have lost
  // them, until it lists them itself (see registerRosterCard).
  registerRosterCard(pi, {
    getLive: (id) => manager.getRecord(id),
    isReachable: (source) => manager.sendRefusalFor(source) === undefined,
  });
  // Last of ours: the widget has its context by now, so restored agents show. Pi awaits it, and
  // runs it before the work host settles its startup, so the items it adopts are not lost.
  pi.on("session_start", async (event, ctx) => {
    await startupRestore.handleSessionStart(event, ctx);
    publishSnapshot();
  });
  pi.on("session_tree", () => {
    eventsObserver.refreshBranch();
    publishSnapshot();
  });
  pi.on("session_before_switch", () => lifecycle.handleSessionBeforeSwitch());
  pi.on("session_shutdown", (event) => lifecycle.handleSessionShutdown(event));
  // Registered after the lifecycle handler on purpose. Pi awaits an extension's
  // handlers for an event in registration order, so the widget is torn down once
  // `suspend()` and the awaited `manager.dispose()` have finished — no terminal
  // transition is left to drive an `update()` at a half-disposed widget.
  pi.on("session_shutdown", () => {
    watch.dispose();
    unsubscribeWatchSettings();
  });
  pi.on("session_shutdown", () => widgetEvents.handleSessionShutdown());

  // Capture the prompt parts Pi assembled for the parent's turn. This is the
  // only event carrying them — `getSystemPromptOptions()` is attached to a
  // command context, not to the session context the runtime holds — and a spawn
  // renders the parent's portable identity from the latest capture.
  pi.on("before_agent_start", (event) => {
    runtime.setSystemPromptOptions(event.systemPromptOptions);
  });

  // Abort all subagents when the parent agent loop is interrupted (ESC), unless
  // the user has turned that policy off. The predicate is read at abort time.
  const interrupt = new InterruptHandler(manager, () => settings.abortAllOnInterrupt);
  pi.on("turn_start", (_event, ctx) => interrupt.handleTurnStart(ctx));
  pi.on("turn_start", () => widgetEvents.handleTurnStart());

  // ---- Agent tool ----

  pi.registerTool(new AgentTool(manager, runtime, settings, registry).toToolDefinition());

  // ---- subagent_get tool ----

  pi.registerTool(new GetResultTool(manager, registry).toToolDefinition());

  // ---- subagent_send tool ----

  pi.registerTool(new SendTool(manager, pi.events, registry, settings).toToolDefinition());

  // Main-only profile hooks register after the orchestration tools exist. Child
  // sessions load fresh extension runtimes without this session's flag/snapshot.
  registerMainAgentProfile(pi);

  // ---- Passive background-agent watch overlay ----

  pi.registerShortcut(Key.ctrlAlt("s"), {
    description: "Show/hide the subagent watch overlay",
    handler: () => watch.toggle(),
  });
  pi.registerCommand("subagent:watch", {
    description: "Show/hide the tailing subagent watch overlay",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        output.show(
          ctx,
          "The subagent watch overlay needs the terminal UI. /subagent:sessions shows a subagent's transcript, and subagent_get reports an agent's status and result.",
          "warning",
        );
        return;
      }
      watch.toggle();
    },
  });

  // ---- /subagent:settings command ----

  const subagentsSettings = new SubagentsSettingsHandler(settings);

  pi.registerCommand("subagent:settings", {
    description: "Configure subagent settings (concurrency, turn limits, retention, watch overlay)",
    handler: async (_args, ctx) => {
      await subagentsSettings.handle({
        ui: {
          select: (title, options) => ctx.ui.select(title, options),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          // The host may drop notifications; the result of a change is shown as a message there.
          notify: (message, level) => output.show(ctx, message, level),
        },
      });
    },
  });

  // ---- /subagent:agents command ----

  pi.registerCommand("subagent:agents", {
    description: "Browse agent definitions, effective settings, and instructions (read-only)",
    handler: async (_args, ctx) => {
      // Fresh definitions for this cwd; never mutate the registry of running children.
      const definitions = new AgentTypeRegistry(() => loadCustomAgents(ctx.cwd));
      if (ctx.mode !== "tui") {
        output.show(
          ctx,
          agentsListText(definitions, { defaultMaxTurns: settings.defaultMaxTurns }),
          "info",
        );
        return;
      }
      await showAgentsBrowser(ctx, definitions, { defaultMaxTurns: settings.defaultMaxTurns });
    },
  });

  // ---- /subagent:sessions command ----

  const sessionNavigator = new SessionNavigatorHandler();

  pi.registerCommand("subagent:sessions", {
    description: "View a subagent's session transcript (read-only)",
    handler: async (_args, ctx) => {
      await sessionNavigator.handle({
        ui: ctx.ui,
        agents: manager.listAgents(),
        registry,
        cwd: ctx.cwd,
        readFile: (path) => readFileSync(path, "utf8"),
        sessionEntries: ctx.sessionManager.getEntries(),
        // Without the terminal UI the pick is a dialog and the transcript a message.
        terminal: ctx.mode === "tui",
        show: (text, level) => output.show(ctx, text, level),
      });
    },
  });
}
