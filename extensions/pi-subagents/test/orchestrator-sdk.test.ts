import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Scripted model responses exercise the real SDK, extensions, todo journals,
// nested worker creation, and resume. This tests capabilities, not model judgment.
it("a child orchestrator tracks work, delegates an implementation, and recalls the same worker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-sdk-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const createRuntime = ModelRuntime.create.bind(ModelRuntime);
  const offline = vi.spyOn(ModelRuntime, "create").mockImplementation(options =>
    createRuntime({ ...options, refreshOnCreate: false }));
  let orchestrator: Awaited<ReturnType<typeof createSubagentSession>> | undefined;
  try {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      extensions: [resolve(import.meta.dirname, "../src/index.ts"), resolve(import.meta.dirname, "../../pi-todo/src/index.ts")],
      compaction: { enabled: false }, retry: { enabled: false },
    }));
    const faux = createFauxCore({ provider: "orchestrator-test", models: [{ id: "coordinator" }] });
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "cache") });
    runtime.registerProvider("orchestrator-test", {
      api: faux.api, apiKey: "test-key", models: faux.models, streamSimple: faux.streamSimple,
    });
    const registry = new AgentTypeRegistry(() => new Map());
    const parentTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "todo", "subagent", "get_subagent_result", "steer_subagent"];
    orchestrator = await createSubagentSession({
      type: "orchestrator",
      snapshot: { cwd: dir, systemPrompt: `PROJECT BASE\nCurrent working directory: ${dir}`, model: faux.getModel(), modelRegistry: new ModelRegistry(runtime) },
    }, {
      registry,
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
    expect(orchestrator.session.getActiveToolNames()).toEqual(expect.arrayContaining(parentTools));
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args));
    let workerId: string | undefined;
    const text = (value: unknown) => JSON.stringify(value);
    faux.setResponses([
      call("todo", { action: "upsert", tasks: [{ key: "implement", subject: "Implementation: create artifact", status: "in_progress" }] }),
      call("subagent", { subagent_type: "general-purpose", description: "Implement artifact", prompt: "Create artifact.txt with verified content. Remember the design rationale for follow-up." }),
      context => {
        const names = context.messages.flatMap(message => message.role === "system" ? message.toolsAdded?.map(tool => tool.name) ?? [] : []);
        expect(names).toContain("write");
        for (const name of ["subagent", "get_subagent_result", "steer_subagent"]) expect(names).not.toContain(name);
        return call("todo", { action: "upsert", tasks: [{ key: "worker-private", subject: "Worker-only notes" }] });
      },
      call("write", { path: join(dir, "artifact.txt"), content: "verified content" }),
      fauxAssistantMessage("Artifact implemented. Rationale: preserve worker context."),
      context => {
        const result = context.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent");
        expect(text(result)).toContain("Artifact implemented");
        workerId = /Agent ID: ([\w-]+)/.exec(text(result))?.[1];
        expect(workerId).toBeTruthy();
        return call("todo", { action: "upsert", tasks: [{ key: "implement", description: `Owner: ${workerId}; follow up on rationale` }] });
      },
      () => call("subagent", { subagent_type: "general-purpose", resume: workerId!, description: "Recall rationale", prompt: "Explain the rationale you retained." }),
      context => {
        expect(text(context.messages)).toContain("Artifact implemented. Rationale: preserve worker context.");
        return fauxAssistantMessage("Recalled rationale from the original worker conversation.");
      },
      () => call("get_subagent_result", { agent_id: workerId!, verbose: true }),
      context => {
        expect(text(context.messages.at(-1))).toContain("Recalled rationale");
        return call("todo", { action: "upsert", tasks: [{ key: "implement", status: "completed", description: `Owner: ${workerId}; artifact verified; rationale recalled` }] });
      },
      fauxAssistantMessage("Project complete; artifact verified and original worker recalled."),
    ]);
    const result = await orchestrator.runTurnLoop("Coordinate the artifact project.", {});
    expect(result.responseText, text(orchestrator.session.messages.filter(message => message.role === "toolResult"))).toContain("Project complete");
    expect(readFileSync(join(dir, "artifact.txt"), "utf8")).toBe("verified content");
    expect(faux.getPendingResponseCount()).toBe(0);
    const journal = orchestrator.session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "pi-personal:todo-state");
    expect(journal.at(-1)).toMatchObject({ data: { tasks: [{ key: "implement", status: "completed", description: expect.stringContaining(workerId!) }] } });
    // The worker's separate todo list must not leak into the project ledger.
    expect(text(journal.at(-1))).not.toContain("worker-private");
  } finally {
    await orchestrator?.dispose();
    offline.mockRestore();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
