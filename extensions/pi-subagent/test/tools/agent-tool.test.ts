import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AgentTool } from "#src/tools/agent-tool";
import { createToolDeps, createToolDepsWithDisabledBuiltInAgents } from "#test/helpers/make-deps";
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

describe("AgentTool — resuming belongs to subagent_send", () => {
  it("has no resume parameter, and the guidance names subagent_send", () => {
    const def = makeTool(createToolDeps()).toToolDefinition();
    const properties = (def.parameters as { properties: Record<string, unknown> }).properties;

    expect(properties).not.toHaveProperty("resume");
    expect(def.description).toContain("subagent_send");
    expect(def.description).not.toContain("subagent_steer");
    expect(def.description).not.toMatch(/Use resume/);
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

  it("documents cwd in the tool guidance and schema", () => {
    const def = makeTool(createToolDeps()).toToolDefinition();
    expect(def.description).toContain("- Use cwd to run the agent in another existing directory");
    expect((def.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty(
      "cwd",
    );
  });
});
