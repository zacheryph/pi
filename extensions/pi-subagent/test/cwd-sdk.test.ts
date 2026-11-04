import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { LIFECYCLE_LOG } from "./fixtures/lifecycle-recorder";

// A real orchestrator session hands a worker a directory it owns (a worktree)
// through subagent_start's cwd, then resumes the worker there.
it("runs a tool-spawned child in the caller's cwd and keeps it resumable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cwd-sdk-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const createRuntime = ModelRuntime.create.bind(ModelRuntime);
  const offline = vi
    .spyOn(ModelRuntime, "create")
    .mockImplementation((options) => createRuntime({ ...options, refreshOnCreate: false }));
  const slots = globalThis as Record<symbol, unknown>;
  slots[LIFECYCLE_LOG] = [];
  let orchestrator: Awaited<ReturnType<typeof createSubagentSession>> | undefined;
  try {
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        extensions: [
          resolve(import.meta.dirname, "../src/index.ts"),
          resolve(import.meta.dirname, "fixtures/lifecycle-recorder.ts"),
        ],
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    );
    const faux = createFauxCore({ provider: "cwd-test", models: [{ id: "coordinator" }] });
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(dir, "cache"),
    });
    runtime.registerProvider("cwd-test", {
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
    const worktree = join(dir, "worktrees", "feat-x");
    mkdirSync(worktree, { recursive: true });
    let workerId: string | undefined;
    let resumeResult = "";
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "subagent_start",
          {
            subagent_type: "general-purpose",
            description: "Build feature",
            prompt: "Build the feature.",
            cwd: "worktrees/feat-x",
          },
          { id: "call-spawn-1" },
        ),
      ),
      fauxAssistantMessage("First pass done."),
      (context) => {
        const result = context.messages.findLast(
          (message) => message.role === "toolResult" && message.toolName === "subagent_start",
        );
        workerId = /Agent ID: ([\w-]+)/.exec(JSON.stringify(result))?.[1];
        return fauxAssistantMessage(
          fauxToolCall(
            "subagent_start",
            {
              subagent_type: "general-purpose",
              description: "Build feature",
              prompt: "Add the tests.",
              resume: workerId ?? "",
            },
            { id: "call-resume-1" },
          ),
        );
      },
      fauxAssistantMessage("Tests added."),
      (context) => {
        const result = context.messages.findLast(
          (message) => message.role === "toolResult" && message.toolName === "subagent_start",
        );
        resumeResult = JSON.stringify(result);
        return fauxAssistantMessage("Delegated.");
      },
    ]);

    await orchestrator.runTurnLoop("Delegate the feature.", {});
    expect(workerId).toBeTruthy();
    expect(resumeResult).toContain("Tests added.");
    expect(resumeResult).not.toContain("resume is unavailable");
    await orchestrator.dispose();
    orchestrator = undefined;

    const log = slots[LIFECYCLE_LOG] as Array<{ channel: string; data: Record<string, unknown> }>;
    const created = log.filter((entry) => entry.channel === "subagent:session:created");
    expect(created).toHaveLength(1);
    expect(created[0].data).toMatchObject({ agentId: workerId, cwd: worktree });
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
