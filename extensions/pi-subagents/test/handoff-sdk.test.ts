import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime,
  SessionManager, SettingsManager, type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { createChildLifecyclePublisher } from "#src/lifecycle/child-lifecycle";
import { createSubagentSession } from "#src/lifecycle/create-subagent-session";
import { buildAgentPrompt } from "#src/session/prompts";
import { LIFECYCLE_LOG } from "./fixtures/lifecycle-recorder";

// A real orchestrator session loads this extension and spawns a worker through
// the subagent tool; the worker's lifecycle events reach the orchestrator's bus.
it("carries the agent id, tool call id and handoff on a tool-spawned child's lifecycle events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-sdk-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const createRuntime = ModelRuntime.create.bind(ModelRuntime);
  const offline = vi.spyOn(ModelRuntime, "create").mockImplementation(options =>
    createRuntime({ ...options, refreshOnCreate: false }));
  const slots = globalThis as Record<symbol, unknown>;
  slots[LIFECYCLE_LOG] = [];
  let orchestrator: Awaited<ReturnType<typeof createSubagentSession>> | undefined;
  try {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      extensions: [resolve(import.meta.dirname, "../src/index.ts"), resolve(import.meta.dirname, "fixtures/lifecycle-recorder.ts")],
      compaction: { enabled: false }, retry: { enabled: false },
    }));
    const faux = createFauxCore({ provider: "handoff-test", models: [{ id: "coordinator" }] });
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "cache") });
    runtime.registerProvider("handoff-test", { api: faux.api, apiKey: "test-key", models: faux.models, streamSimple: faux.streamSimple });
    const parentTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "subagent", "get_subagent_result", "steer_subagent"];
    orchestrator = await createSubagentSession({
      type: "orchestrator",
      snapshot: { cwd: dir, systemPrompt: "PROJECT BASE", model: faux.getModel(), modelRegistry: new ModelRegistry(runtime) },
    }, {
      registry: new AgentTypeRegistry(() => new Map()),
      exec: vi.fn(),
      lifecycle: createChildLifecyclePublisher(() => {}),
      resolvePromptInheritance: () => "full",
      listParentToolNames: () => parentTools,
      io: {
        detectEnv: async () => ({ isGitRepo: false, branch: "", platform: "linux" }),
        getAgentDir: () => dir,
        deriveSessionDir: () => join(dir, "sessions"),
        createSessionManager: (cwd, sessionDir) => SessionManager.create(cwd, sessionDir),
        createSettingsManager: (cwd, agentDir) => SettingsManager.create(cwd, agentDir),
        createLoaderSettingsManager: settings => settings,
        createResourceLoader: options => new DefaultResourceLoader({ ...options, noSkills: true }),
        createSession: async ({ sessionManager, resourceLoader, modelRegistry: _registry, ...rest }) => createAgentSession({
          ...rest, sessionManager: sessionManager as SessionManager, resourceLoader: resourceLoader as ResourceLoader, modelRuntime: runtime,
        }),
        assemblerIO: { buildAgentPrompt, loadProjectContext: () => undefined },
      },
    });
    let workerId: string | undefined;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("subagent", {
        subagent_type: "general-purpose", description: "Audit auth", prompt: "Audit the auth module.",
        todos: ["auth-audit", " auth-tests ", "auth-audit"], todo_scope: "ledger",
      }, { id: "call-spawn-1" })),
      fauxAssistantMessage("Audit done."),
      context => {
        const result = context.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent");
        workerId = /Agent ID: ([\w-]+)/.exec(JSON.stringify(result))?.[1];
        return fauxAssistantMessage("Delegated.");
      },
    ]);

    await orchestrator.runTurnLoop("Delegate the audit.", {});
    expect(workerId).toBeTruthy();
    await orchestrator.dispose();
    orchestrator = undefined;

    const log = slots[LIFECYCLE_LOG] as Array<{ channel: string; data: Record<string, unknown> }>;
    const created = log.find(entry => entry.channel === "subagents:child:session-created")?.data;
    expect(created).toEqual({
      sessionId: expect.any(String), parentSessionId: expect.any(String),
      agentId: workerId, toolCallId: "call-spawn-1",
      handoff: { todos: { keys: ["auth-audit", "auth-tests"], scope: "ledger" } },
    });
    for (const channel of ["subagents:child:bound", "subagents:child:disposed"]) {
      expect(log.find(entry => entry.channel === channel)?.data, channel).toMatchObject({
        sessionId: created!.sessionId, agentId: workerId, toolCallId: "call-spawn-1",
      });
    }
  } finally {
    await orchestrator?.dispose();
    offline.mockRestore();
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Symbol-keyed global in tests
    delete slots[LIFECYCLE_LOG];
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
