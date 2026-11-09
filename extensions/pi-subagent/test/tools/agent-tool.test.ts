import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AgentTool } from "#src/tools/agent-tool";
import {
  createToolDeps,
  createToolDepsWithDisabledBuiltInAgents,
  mockResumeStart,
  mockResumeStartRefusal,
} from "#test/helpers/make-deps";
import { createTestSubagent } from "#test/helpers/make-subagent";

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    ui: { fake: true },
    ...overrides,
  } as unknown as ExtensionContext;
}

function makeTool(deps: ReturnType<typeof createToolDeps>) {
  return new AgentTool(deps.manager, deps.runtime, deps.settings, deps.registry);
}

async function execute(
  deps: ReturnType<typeof createToolDeps>,
  params: Record<string, unknown>,
  ctx?: ReturnType<typeof makeCtx>,
) {
  return makeTool(deps).execute(
    "tc-1",
    params,
    new AbortController().signal,
    vi.fn(),
    ctx ?? makeCtx(),
  );
}

describe("AgentTool", () => {
  it("returns tool definition with correct name and label", () => {
    const def = makeTool(createToolDeps()).toToolDefinition();
    expect(def.name).toBe("subagent_start");
    expect(def.label).toBe("Subagent");
  });

  it("includes promptSnippet", () => {
    const def = makeTool(createToolDeps()).toToolDefinition();
    expect(def.promptSnippet).toBe("Launch a specialized agent for complex, multi-step tasks.");
  });

  it("lists every built-in agent with its guidance on one line", () => {
    const def = makeTool(createToolDeps()).toToolDefinition();
    expect(def.description).toContain(
      "- explore (claude-haiku@latest): Fast codebase exploration (read-only). Use for codebase searches and code understanding.",
    );
    expect(def.description).toContain(
      "- general-purpose: Copy of you: your own instructions and every tool, with no role of its own. Use only when no other agent type fits the task.",
    );
  });

  it.for(["general-purpose", "orchestrate", "explore", "plan", "review"])(
    "names %s once",
    (name) => {
      const def = makeTool(createToolDeps()).toToolDefinition();
      expect(def.description.match(new RegExp(`\\b${name}\\b`, "g"))).toHaveLength(1);
    },
  );

  it("leaves agent authoring out of the tool's description and parameters", () => {
    const def = makeTool(createToolDeps()).toToolDefinition();
    const text = JSON.stringify(def.parameters) + def.description;
    expect(text).not.toContain(".pi/agents");
    expect(text).not.toMatch(/Default agents|Custom agents/);
  });

  it.for(["explore", "plan", "general-purpose"])(
    "omits the type-list entry for a disabled built-in %s",
    (name) => {
      const def = makeTool(createToolDepsWithDisabledBuiltInAgents(name)).toToolDefinition();
      expect(def.description).not.toContain(`- ${name}`);
    },
  );

  it("calls registry.reload() on each execute", async () => {
    const deps = createToolDeps();
    const reloadSpy = vi.spyOn(deps.registry, "reload");
    await execute(deps, {
      prompt: "test",
      description: "test",
      subagent_type: "general-purpose",
    });
    expect(reloadSpy).toHaveBeenCalledOnce();
    reloadSpy.mockRestore();
  });
});

describe("AgentTool — resume path", () => {
  const resumeCall = {
    prompt: "continue",
    description: "resume",
    subagent_type: "general-purpose",
    resume: "agent-1",
  };

  describe("refused", () => {
    it("names an id no record answers to", async () => {
      const deps = createToolDeps();
      mockResumeStartRefusal(deps, "unknown-agent");
      const result = await execute(deps, { ...resumeCall, resume: "nonexistent" });
      expect(result.content[0].text).toBe(
        'Agent not found: "nonexistent". It is not live in this session; subagent_get without ' +
          "agent_id lists the agents started on this branch, including any from before a reload or resume.",
      );
    });

    it("names a missing session without offering a cleanup story it cannot tell", async () => {
      const deps = createToolDeps();
      mockResumeStartRefusal(deps, "no-session");
      const result = await execute(deps, resumeCall);
      expect(result.content[0].text).toBe('Agent "agent-1" has no active session to resume.');
    });

    it("points a released-agent resume at subagent_get instead of resuming", async () => {
      const deps = createToolDeps();
      mockResumeStartRefusal(deps, "session-released");
      const result = await execute(deps, resumeCall);
      expect(result.content[0].text).toBe(
        'Agent "agent-1" had its session released and its saved transcript is gone; resume is ' +
          "unavailable, but its result is still retrievable via subagent_get.",
      );
    });

    it("tells the parent to wait out a run that has not finished", async () => {
      const deps = createToolDeps();
      mockResumeStartRefusal(deps, "still-running");

      const result = await execute(deps, resumeCall);

      expect(result.content[0].text).toBe(
        'Agent "agent-1" is still running; wait for it to finish before resuming. ' +
          "Use subagent_steer to send it a message while it runs.",
      );
    });
  });

  describe("started", () => {
    it("starts the resume without waiting for it, with no signal", async () => {
      const deps = createToolDeps();
      mockResumeStart(deps);

      await execute(deps, resumeCall);

      expect(deps.manager.startResume).toHaveBeenCalledWith("agent-1", "continue", {});
    });

    it("returns the background launch message for the resumed agent", async () => {
      const deps = createToolDeps();
      mockResumeStart(deps);

      const result = await execute(deps, { ...resumeCall, description: "answer" });

      expect(result.content[0].text).toBe(
        "Agent resumed in background.\n" +
          "Agent ID: agent-1\n" +
          "Type: agent\n" +
          "Description: answer\n" +
          "\nYou will be notified when this agent completes.\n" +
          "Use subagent_get to retrieve full results, or subagent_steer to send it messages.\n" +
          "Do not duplicate this agent's work.",
      );
      expect(result.details).toMatchObject({ status: "background", agentId: "agent-1" });
    });

    it("leaves the resumed outcome to the completion message", async () => {
      const deps = createToolDeps();
      const record = mockResumeStart(deps);

      await execute(deps, resumeCall);

      expect(record.consumed).toBe(false);
    });

    it.for([undefined, "print", "json"])(
      "resumes in the background whatever the call or the run mode says (%s)",
      async (mode) => {
        const deps = createToolDeps();
        mockResumeStart(deps);

        const result = await execute(
          deps,
          { ...resumeCall, foreground: true },
          mode ? makeCtx({ mode }) : undefined,
        );

        expect(deps.manager.startResume).toHaveBeenCalledOnce();
        expect(result.content[0].text).toContain("Agent resumed in background.");
      },
    );
  });
});

describe("AgentTool — model resolution error", () => {
  it("returns error when model resolution fails", async () => {
    const deps = createToolDeps();
    const result = await execute(deps, {
      prompt: "test",
      description: "test",
      subagent_type: "general-purpose",
      model: "nonexistent-model-xyz",
    });
    // User-specified model that doesn't resolve → error message
    expect(result.content[0].text).toContain("nonexistent-model-xyz");
  });
});

describe("AgentTool — background execution", () => {
  it("returns background launch message with agent ID", async () => {
    const deps = createToolDeps();
    const record = createTestSubagent({ status: "running" });
    deps.manager.getRecord = vi.fn().mockReturnValue(record);
    const result = await execute(deps, {
      prompt: "do something",
      description: "bg task",
      subagent_type: "general-purpose",
    });
    const text = result.content[0].text;
    expect(text).toContain("background");
    expect(text).toContain("agent-1");
    expect(text).toContain("bg task");
  });

  it("does not emit subagent:created directly — delegated to observer.onSubagentCreated", async () => {
    // The subagent:created event is now emitted by SubagentManagerObserver.onSubagentCreated,
    // called from SubagentManager.spawn(). Tested in subagent-manager.test.ts.
    // This test ensures the tool no longer holds an emitEvent dep for this purpose.
    const deps = createToolDeps();
    deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent({ status: "running" }));
    const result = await execute(deps, {
      prompt: "do something",
      description: "bg task",
      subagent_type: "general-purpose",
    });
    // Background spawn succeeds — no emitEvent dep required
    expect(result.content[0].text).toContain("background");
  });

  it("passes parentSession.toolCallId to manager.spawn", async () => {
    const deps = createToolDeps();
    deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent({ status: "running" }));
    await execute(deps, {
      prompt: "do something",
      description: "bg task",
      subagent_type: "general-purpose",
    });
    const spawnOpts = (deps.manager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(spawnOpts.parentSession?.toolCallId).toBe("tc-1");
  });
});

describe("AgentTool — execution mode", () => {
  const params = { prompt: "do task", description: "task", subagent_type: "general-purpose" };

  it("always runs in the background and returns the agent ID at once", async () => {
    const deps = createToolDeps();
    deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent({ status: "running" }));

    const result = await execute(deps, params);

    expect(deps.manager.spawn).toHaveBeenCalledOnce();
    expect(result.content[0].text).toContain("Agent ID: agent-1");
  });

  it.for([undefined, "print", "json"])(
    "stays in the background whatever the call or the run mode says (%s)",
    async (mode) => {
      const deps = createToolDeps();
      deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent({ status: "running" }));

      const result = await execute(
        deps,
        { ...params, foreground: true },
        mode ? makeCtx({ mode }) : undefined,
      );

      expect(deps.manager.spawn).toHaveBeenCalledOnce();
      expect(result.content[0].text).toContain("in background");
    },
  );

  it("offers no foreground or run_in_background parameter, and tells the model to end its turn", () => {
    const def = makeTool(createToolDeps()).toToolDefinition();
    const properties = (def.parameters as { properties: Record<string, unknown> }).properties;

    expect(properties).not.toHaveProperty("foreground");
    expect(properties).not.toHaveProperty("run_in_background");
    expect(def.description).toContain("then end your turn instead of waiting");
    expect(def.description).not.toMatch(/foreground|run_in_background|wait: true/);
  });

  it("tells the model large results come back through stash handles", () => {
    const def = makeTool(createToolDeps()).toToolDefinition();

    expect(def.description).toContain("stash_put");
    expect(def.description).toContain("name the stash handle in their final answer");
  });
});

describe("AgentTool — cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-tool-cwd-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("passes an existing directory to a background spawn", async () => {
    const deps = createToolDeps();
    deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent({ status: "running" }));
    await execute(deps, {
      prompt: "do something",
      description: "bg task",
      subagent_type: "general-purpose",
      cwd: dir,
    });
    const spawnOpts = (deps.manager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(spawnOpts.cwd).toBe(dir);
  });

  it("omits cwd when the call does not set one", async () => {
    const deps = createToolDeps();
    deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent({ status: "running" }));
    await execute(deps, {
      prompt: "do something",
      description: "bg task",
      subagent_type: "general-purpose",
    });
    const spawnOpts = (deps.manager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(spawnOpts).not.toHaveProperty("cwd");
  });

  it("refuses a directory that does not exist and spawns nothing", async () => {
    const deps = createToolDeps();
    const result = await execute(deps, {
      prompt: "do something",
      description: "bg task",
      subagent_type: "general-purpose",
      cwd: join(dir, "missing"),
    });
    expect(result.content[0].text).toBe(`cwd ${join(dir, "missing")} is not an existing directory`);
    expect(deps.manager.spawn).not.toHaveBeenCalled();
  });

  it("refuses cwd on a resume", async () => {
    const deps = createToolDeps();
    const result = await execute(deps, {
      prompt: "continue",
      description: "resume",
      subagent_type: "general-purpose",
      resume: "agent-1",
      cwd: dir,
    });
    expect(result.content[0].text).toContain("cwd applies only to a new agent");
    expect(deps.manager.startResume).not.toHaveBeenCalled();
  });

  it("documents cwd in the tool guidance and schema", () => {
    const def = makeTool(createToolDeps()).toToolDefinition();
    expect(def.description).toContain("- Use cwd to run the agent in another existing directory");
    expect((def.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty(
      "cwd",
    );
  });
});
