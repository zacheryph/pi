import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { createSubagentSession, type CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import { SubagentManager } from "#src/lifecycle/subagent-manager";
import { buildAgentPrompt } from "#src/session/prompts";
import type { AgentConfig } from "#src/types";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { createAgentLookup, createFactorySession, createSubagentSessionDeps, createSubagentSessionIO } from "#test/helpers/subagent-session-io";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const background = { kind: "explicit", isBackground: true } as const;

describe("child fragment spawn snapshots", () => {
  let root: string;
  let profile: AgentConfig;
  let manager: SubagentManager;
  let io: ReturnType<typeof createSubagentSessionIO>;
  let registry: AgentTypeRegistry;
  let sessionRegistry: ReturnType<typeof createAgentLookup>;
  let factory: ReturnType<typeof vi.fn<(params: CreateSubagentSessionParams) => ReturnType<typeof createSubagentSession>>>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-child-fragments-"));
    const agents = join(root, "source", "agents");
    mkdirSync(join(agents, "fragments"), { recursive: true });
    writeFileSync(join(agents, "fragments", "aws.md"), "AWS source instructions.\n");
    profile = {
      name: "aws-child",
      description: "AWS child",
      systemPrompt: "Child body.",
      promptMode: "replace",
      toolNames: ["read"],
      fragments: ["aws"],
      source: "global",
      sourcePath: join(agents, "aws-child.md"),
    };
    registry = new AgentTypeRegistry(() => new Map([[profile.name, profile]]));
    // Fragment-bearing spawns bypass this live lookup; no-fragment spawns
    // retain their existing run-start registry behavior.
    sessionRegistry = createAgentLookup();
    sessionRegistry.resolveAgentConfig.mockImplementation(type => registry.resolveAgentConfig(type));
    sessionRegistry.getToolNamesForType.mockImplementation(type => registry.getToolNamesForType(type));
    io = createSubagentSessionIO();
    io.assemblerIO.buildAgentPrompt.mockImplementation(buildAgentPrompt);
    io.createSession.mockImplementation(async () => ({ session: createFactorySession() }));
    const deps = createSubagentSessionDeps({ io, registry: sessionRegistry });
    factory = vi.fn((params: CreateSubagentSessionParams) => createSubagentSession(params, deps));
    manager = new SubagentManager({
      registry,
      createSubagentSession: factory,
      limiter: new ConcurrencyLimiter(() => 1),
      baseCwd: STUB_SNAPSHOT.cwd,
    });
    vi.mocked(readFileSync).mockClear();
  });

  afterEach(async () => {
    await manager.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  function fragmentPath() {
    return join(root, "source", "agents", "fragments", "aws.md");
  }

  function spawn() {
    return manager.spawn(STUB_SNAPSHOT, profile.name, "Task", { description: "Task", background });
  }

  function childPrompt(index = 0) {
    return io.createResourceLoader.mock.calls[index][0].systemPromptOverride();
  }

  it("composes [aws] relative to source profile, not child workspace cwd", async () => {
    const childCwd = join(root, "different-workspace");
    mkdirSync(join(childCwd, "fragments"), { recursive: true });
    writeFileSync(join(childCwd, "fragments", "aws.md"), "Wrong workspace instructions.");
    manager.registerWorkspaceProvider({
      prepare: async () => ({ cwd: childCwd, dispose: () => ({}) }),
    });

    const record = await manager.spawnAndWait(STUB_SNAPSHOT, profile.name, "Task", { description: "Task" });

    expect(record.status).toBe("completed");
    expect(childPrompt()).toContain("AWS source instructions.\n\n---\n\nChild body.");
    expect(childPrompt()).not.toContain("Wrong workspace instructions.");
    expect(io.createSession.mock.calls[0][0].cwd).toBe(childCwd);
    expect(readFileSync).toHaveBeenCalledExactlyOnceWith(fragmentPath(), "utf8");
    expect(sessionRegistry.resolveAgentConfig).not.toHaveBeenCalled();
    expect(sessionRegistry.getToolNamesForType).not.toHaveBeenCalled();
  });

  it.each([
    { fragments: ["missing"], error: /fragment "missing"/ },
    { fragments: ["aws.md"], error: /Invalid fragment name/ },
    { fragments: ["../aws"], error: /Invalid fragment name/ },
    { fragmentError: "fragments must be an array of names", error: /must be an array/ },
  ])("refuses invalid or missing references before session creation: $error", async ({ error, ...config }) => {
    Object.assign(profile, config);

    expect(spawn).toThrow(error);
    await expect(manager.spawnAndWait(STUB_SNAPSHOT, profile.name, "Task", { description: "Task" })).rejects.toThrow(error);

    expect(manager.listAgents()).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
    expect(io.createSession).not.toHaveBeenCalled();
    if (config.fragments?.[0] !== "missing") expect(readFileSync).not.toHaveBeenCalled();
  });

  it.each([undefined, []])("preserves no-fragment instructions exactly (%s)", async (fragments) => {
    profile.fragments = fragments;
    profile.systemPrompt = "  Original body.\n\n";
    profile.source = "project";

    const record = await manager.spawnAndWait(STUB_SNAPSHOT, profile.name, "Task", { description: "Task" });

    expect(record.status).toBe("completed");
    expect(factory.mock.calls[0][0].agentConfig).toBeUndefined();
    expect(io.assemblerIO.buildAgentPrompt.mock.calls[0][0].systemPrompt).toBe(profile.systemPrompt);
    expect(childPrompt()).toBe(buildAgentPrompt(profile, STUB_SNAPSHOT.cwd,
      { isGitRepo: false, branch: "", platform: "linux" },
      { systemPrompt: STUB_SNAPSHOT.systemPrompt, cwd: STUB_SNAPSHOT.cwd, strategy: "full" },
      io.assemblerIO.loadProjectContext));
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it.each(["edit", "delete"])("freezes queued content/config before later %s and registry reload", async (change) => {
    const gate = Promise.withResolvers<void>();
    const firstSession = createFactorySession();
    firstSession.prompt.mockImplementation(async () => gate.promise);
    io.createSession.mockResolvedValueOnce({ session: firstSession });
    const first = manager.spawn(STUB_SNAPSHOT, "general-purpose", "Hold slot", { description: "Hold", background });
    const queued = spawn();
    expect(manager.getRecord(queued)?.status).toBe("queued");
    expect(readFileSync).toHaveBeenCalledExactlyOnceWith(fragmentPath(), "utf8");

    if (change === "edit") writeFileSync(fragmentPath(), "Changed instructions.");
    else unlinkSync(fragmentPath());
    profile.systemPrompt = "Changed child body.";
    profile.toolNames!.push("bash");
    profile.fragments!.push("missing");
    registry.reload();
    gate.resolve();
    await manager.getRecord(first)!.promise;
    await manager.getRecord(queued)!.promise;

    expect(manager.getRecord(queued)?.status).toBe("completed");
    expect(childPrompt(1)).toContain("AWS source instructions.\n\n---\n\nChild body.");
    expect(childPrompt(1)).not.toContain("Changed");
    expect(io.createSession.mock.calls[1][0].tools).toEqual(["read", "ask_parent", "notify_parent"]);
    const prepared = factory.mock.calls[1][0].agentConfig!;
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.toolNames)).toBe(true);
    expect(prepared.fragments).toEqual(["aws"]);
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it("keeps run-start registry resolution for queued no-fragment profiles", async () => {
    profile.fragments = [];
    const gate = Promise.withResolvers<void>();
    const firstSession = createFactorySession();
    firstSession.prompt.mockImplementation(async () => gate.promise);
    io.createSession.mockResolvedValueOnce({ session: firstSession });
    const first = manager.spawn(STUB_SNAPSHOT, "general-purpose", "Hold slot", { description: "Hold", background });
    const queued = spawn();
    profile.systemPrompt = "Updated legacy body.";
    profile.toolNames = ["grep"];
    registry.reload();
    gate.resolve();
    await manager.getRecord(first)!.promise;
    await manager.getRecord(queued)!.promise;

    expect(factory.mock.calls[1][0].agentConfig).toBeUndefined();
    expect(childPrompt(1)).toContain("Updated legacy body.");
    expect(io.createSession.mock.calls[1][0].tools).toEqual(["grep", "ask_parent", "notify_parent"]);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it.each([{ fragments: ["aws"] }, { fragmentError: "Invalid declaration" }])(
    "refuses queued no-fragment profiles gaining unprepared declarations (%s)", async (declaration) => {
      profile.fragments = [];
      const gate = Promise.withResolvers<void>();
      const firstSession = createFactorySession();
      firstSession.prompt.mockImplementation(async () => gate.promise);
      io.createSession.mockResolvedValueOnce({ session: firstSession });
      const first = manager.spawn(STUB_SNAPSHOT, "general-purpose", "Hold slot", { description: "Hold", background });
      const queued = spawn();
      Object.assign(profile, declaration);
      registry.reload();
      gate.resolve();
      await manager.getRecord(first)!.promise;
      await manager.getRecord(queued)!.promise;

      expect(manager.getRecord(queued)?.status).toBe("error");
      expect(manager.getRecord(queued)?.error).toContain("fragment instructions were not prepared at spawn; start a new agent");
      expect(io.createSession).toHaveBeenCalledTimes(1);
      expect(readFileSync).not.toHaveBeenCalled();
    },
  );

  it("resume reuses original session prompt without file or registry reads", async () => {
    const id = spawn();
    await manager.getRecord(id)!.promise;
    const originalPrompt = childPrompt();
    unlinkSync(fragmentPath());
    profile.fragmentError = "No longer valid";
    profile.systemPrompt = "Changed body.";
    registry.reload();
    vi.mocked(readFileSync).mockClear();
    const registryRead = vi.spyOn(registry, "resolveAgentConfig");

    const outcome = await manager.resume(id, "More work");

    expect(outcome.kind).toBe("resumed");
    expect(manager.getRecord(id)?.status).toBe("completed");
    expect(childPrompt()).toBe(originalPrompt);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(io.createSession).toHaveBeenCalledTimes(1);
    expect(readFileSync).not.toHaveBeenCalled();
    expect(registryRead).not.toHaveBeenCalled();
  });

  it.each([false, undefined])("rejects untrusted project fragments without file reads (trust=%s)", (projectTrusted) => {
    profile.source = "project";

    expect(() => manager.spawn({ ...STUB_SNAPSHOT, projectTrusted }, profile.name, "Task", { description: "Task", background }))
      .toThrow(/require Pi project trust/);

    expect(readFileSync).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it("accepts explicitly trusted project fragments", async () => {
    profile.source = "project";

    const record = await manager.spawnAndWait({ ...STUB_SNAPSHOT, projectTrusted: true }, profile.name, "Task", { description: "Task" });

    expect(record.status).toBe("completed");
    expect(childPrompt()).toContain("AWS source instructions.");
    expect(readFileSync).toHaveBeenCalledExactlyOnceWith(fragmentPath(), "utf8");
  });
});
