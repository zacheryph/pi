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

// A real orchestrator session (pi-subagents + pi-todo) hands two tasks to a
// worker through handoff.todos. Scripted model responses, real SDK sessions.
it("hands todo tasks to a worker that sees and updates only those, in the orchestrator's list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "todo-handoff-sdk-"));
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
          resolve(import.meta.dirname, "../../pi-todo/src/index.ts"),
        ],
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    );
    const faux = createFauxCore({ provider: "todo-handoff-test", models: [{ id: "coordinator" }] });
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(dir, "cache"),
    });
    runtime.registerProvider("todo-handoff-test", {
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
      "todo",
      "subagent",
      "get_subagent_result",
      "steer_subagent",
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
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1], id?: string) =>
      fauxAssistantMessage(fauxToolCall(name, args, id ? { id } : undefined));
    const text = (value: unknown) => JSON.stringify(value);
    const lastResult = (messages: { role: string }[], tool: string) =>
      messages.findLast(
        (message) =>
          message.role === "toolResult" && (message as { toolName?: string }).toolName === tool,
      );
    const spawn = (keys: string[], id: string) =>
      call(
        "subagent",
        {
          subagent_type: "general-purpose",
          description: "Audit auth",
          prompt: "Audit auth and write its tests.",
          handoff: { todos: { keys } },
        },
        id,
      );
    faux.setResponses([
      call("todo", {
        action: "upsert",
        tasks: [
          { key: "audit", subject: "Audit auth" },
          { key: "tests", subject: "Write auth tests" },
          { key: "ship", subject: "Ship release" },
        ],
      }),
      spawn(["missing"], "call-bad"),
      (context) => {
        expect(text(lastResult(context.messages, "subagent"))).toContain(
          "Cannot hand off todo tasks: unknown task: missing",
        );
        return spawn(["audit", "tests"], "call-spawn");
      },
      // The worker's turn loop.
      call("todo", { action: "list" }),
      (context) => {
        const listed = text(lastResult(context.messages, "todo"));
        expect(listed).toContain("audit");
        expect(listed).toContain("tests");
        expect(listed).not.toContain("ship");
        return call("todo", {
          action: "upsert",
          tasks: [
            { key: "audit", status: "completed", message: "Session cookie path is sound." },
            { key: "rotate-key", subject: "Rotate signing key", dependsOn: ["audit"] },
          ],
        });
      },
      call("todo", { action: "upsert", tasks: [{ key: "ship", status: "completed" }] }),
      (context) => {
        expect(text(lastResult(context.messages, "todo"))).toContain(
          "task ship is not assigned to you",
        );
        return fauxAssistantMessage("Audit finished; follow-up added.");
      },
      // Back in the orchestrator.
      call("todo", { action: "list" }),
      fauxAssistantMessage("Delegated."),
    ]);

    await orchestrator.runTurnLoop("Delegate the auth work.", {});
    expect(faux.getPendingResponseCount()).toBe(0);

    const branch = orchestrator.session.sessionManager.getBranch();
    const journal = branch
      .filter((entry) => entry.type === "custom" && entry.customType === "pi-personal:todo-state")
      .at(-1) as {
      data: {
        tasks: { key: string; status: string }[];
        activity: Record<string, { updates: { message?: string; agent?: string }[] }>;
      };
    };
    expect(journal.data.tasks.map((task) => [task.key, task.status])).toEqual([
      ["audit", "completed"],
      ["tests", "pending"],
      ["ship", "pending"],
      ["rotate-key", "pending"],
    ]);
    const audit = journal.data.activity.audit.updates.find(
      (update) => update.message === "Session cookie path is sound.",
    );
    expect(audit?.agent).toEqual(expect.any(String));
    const claims = branch
      .filter((entry) => entry.type === "custom" && entry.customType === "pi-personal:todo-claims")
      .map((entry) => (entry as { data: { op: string; agent: string; keys?: string[] } }).data);
    expect(claims.map((entry) => [entry.op, entry.keys])).toEqual([
      ["claim", ["audit", "tests"]],
      ["claim", ["rotate-key"]],
      ["release", undefined],
    ]);
    expect(new Set(claims.map((entry) => entry.agent))).toEqual(new Set([audit!.agent]));
  } finally {
    await orchestrator?.dispose();
    offline.mockRestore();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
