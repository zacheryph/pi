import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { createChildLifecyclePublisher } from "#src/lifecycle/child-lifecycle";
import { createSubagentSession } from "#src/lifecycle/create-subagent-session";
import { buildAgentPrompt } from "#src/session/prompts";

// A real orchestrator session loads this extension and pi-ask, and spawns a
// worker whose `ask` call turns toward the orchestrator: the question lands on
// the worker's record and in the orchestrator's subagent_start result.
it("routes a child's ask to its parent through pi-ask", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ask-sdk-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const createRuntime = ModelRuntime.create.bind(ModelRuntime);
  const offline = vi
    .spyOn(ModelRuntime, "create")
    .mockImplementation((options) => createRuntime({ ...options, refreshOnCreate: false }));
  let orchestrator: Awaited<ReturnType<typeof createSubagentSession>> | undefined;
  try {
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        extensions: [
          resolve(import.meta.dirname, "../src/index.ts"),
          resolve(import.meta.dirname, "../../pi-ask/src/index.ts"),
        ],
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    );
    const faux = createFauxCore({ provider: "ask-test", models: [{ id: "coordinator" }] });
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(dir, "cache"),
    });
    runtime.registerProvider("ask-test", {
      api: faux.api,
      apiKey: "test-key",
      models: faux.models,
      streamSimple: faux.streamSimple,
    });
    const parentTools = [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "subagent_start",
      "subagent_get",
      "subagent_steer",
    ];
    orchestrator = await createSubagentSession(
      {
        type: "orchestrator",
        snapshot: {
          cwd: dir,
          systemPrompt: "PROJECT BASE",
          model: faux.getModel(),
          modelRegistry: new ModelRegistry(runtime),
        },
      },
      {
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
          openSessionManager: (path, cwd) => SessionManager.open(path, undefined, cwd),
          createSettingsManager: (cwd, agentDir) => SettingsManager.create(cwd, agentDir),
          createLoaderSettingsManager: (settings) => settings,
          createResourceLoader: (options) =>
            new DefaultResourceLoader({ ...options, noSkills: true }),
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
    let childTools: string[] = [];
    let spawnResult = "";
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("subagent_start", {
          subagent_type: "general-purpose",
          description: "Pick storage",
          prompt: "Set up storage.",
        }),
      ),
      (context) => {
        childTools = context.messages.flatMap((message) =>
          message.role === "system" ? (message.toolsAdded?.map((tool) => tool.name) ?? []) : [],
        );
        return fauxAssistantMessage(
          fauxToolCall("ask", {
            questions: [
              {
                question: "Which database?",
                header: "Storage",
                options: [{ label: "Postgres" }, { label: "SQLite" }],
              },
            ],
          }),
        );
      },
      (context) => {
        const recorded = context.messages.findLast(
          (message) => message.role === "toolResult" && message.toolName === "ask",
        );
        expect(JSON.stringify(recorded)).toContain("End your turn now");
        return fauxAssistantMessage("Waiting for the storage decision.");
      },
      (context) => {
        const result = context.messages.findLast(
          (message) => message.role === "toolResult" && message.toolName === "subagent_start",
        );
        spawnResult = JSON.stringify(result);
        return fauxAssistantMessage("Asked.");
      },
    ]);

    await orchestrator.runTurnLoop("Delegate storage.", {});
    expect(faux.getPendingResponseCount()).toBe(0);
    expect(childTools).toContain("ask");
    expect(spawnResult).toContain("[Storage] Which database?");
    expect(spawnResult).toContain("a) Postgres");
    expect(spawnResult).toContain("resume");
  } finally {
    await orchestrator?.dispose();
    offline.mockRestore();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
