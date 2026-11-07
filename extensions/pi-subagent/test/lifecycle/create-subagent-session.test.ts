import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { service } from "../../../../packages/pi-session-tree/src/index.ts";
import type {
  CreateSessionOptions,
  ResourceLoaderOptions,
} from "#src/lifecycle/create-subagent-session";
import { createSubagentSession } from "#src/lifecycle/create-subagent-session";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { SubagentSession } from "#src/lifecycle/subagent-session";
import type { AgentConfig } from "#src/types";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import {
  createAgentLookup,
  createChildLifecycleMock,
  createFactorySession,
  createSubagentSessionDeps,
  createSubagentSessionIO,
} from "#test/helpers/subagent-session-io";

/** Mock AgentConfigLookup. */
const mockAgentLookup = createAgentLookup();

let io: ReturnType<typeof createSubagentSessionIO>;

const exec = vi.fn();

beforeEach(() => {
  io = createSubagentSessionIO();
});

/** Arrange: build a factory session and wire it as the created session. Returns it for assertions. */
function arrangeFactory() {
  const session = createFactorySession();
  io.createSession.mockResolvedValue({ session });
  return session;
}

/** The standard deps bag for the default `io`/`exec`/`registry` wiring. */
function defaultDeps() {
  return createSubagentSessionDeps({ io, exec, registry: mockAgentLookup });
}

describe("createSubagentSession — assembly", () => {
  let session: ReturnType<typeof createFactorySession>;

  beforeEach(() => {
    session = createFactorySession();
    io.createSession.mockResolvedValue({ session });
  });

  it("returns a born-complete SubagentSession wrapping the created session", async () => {
    const sub = await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(sub).toBeInstanceOf(SubagentSession);
    expect(sub.session).toBe(session);
  });

  describe("reopening a saved transcript", () => {
    const reopen = () =>
      createSubagentSession(
        {
          snapshot: STUB_SNAPSHOT,
          type: "explore",
          cwd: "/worktree",
          transcriptPath: "/old-parent/tasks/agent.jsonl",
        },
        createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
      );

    it("opens that file in the agent's directory instead of starting a new one", async () => {
      const sub = await reopen();
      expect(io.openSessionManager).toHaveBeenCalledWith(
        "/old-parent/tasks/agent.jsonl",
        "/worktree",
      );
      expect(io.createSessionManager).not.toHaveBeenCalled();
      expect(sub.outputFile).toBe("/mock/session-dir/tasks/reopened.jsonl");
    });

    it("starts no new session in it", async () => {
      await reopen();
      const manager = io.openSessionManager.mock.results[0].value as { newSession: Mock };
      expect(manager.newSession).not.toHaveBeenCalled();
    });

    it("tells the child's extensions it is a resume", async () => {
      await reopen();
      expect(io.createSession.mock.calls[0][0]).toMatchObject({
        sessionStartEvent: { type: "session_start", reason: "resume" },
      });
    });

    it("reports the transcript's own directory, not one derived from the parent", async () => {
      await reopen();
      expect(io.deriveSessionDir).not.toHaveBeenCalled();
    });

    it("leaves a new session as a plain startup", async () => {
      await createSubagentSession(
        { snapshot: STUB_SNAPSHOT, type: "explore" },
        createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
      );
      expect(io.openSessionManager).not.toHaveBeenCalled();
      expect(io.createSession.mock.calls[0][0]).not.toHaveProperty("sessionStartEvent");
    });
  });

  it("exposes the persisted session file as outputFile", async () => {
    const sub = await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(sub.outputFile).toBe("/sessions/child.jsonl");
  });

  it("binds extensions before returning", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith({});
  });

  it("passes the effective cwd and agentDir to the loader, settings, and session", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore", cwd: "/tmp/worktree" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(io.getAgentDir).toHaveBeenCalledTimes(1);
    expect(io.createResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/worktree", agentDir: "/mock/agent-dir" }),
    );
    expect(io.createSettingsManager).toHaveBeenCalledWith("/tmp/worktree", "/mock/agent-dir");
    expect(io.createSessionManager).toHaveBeenCalledWith(
      "/tmp/worktree",
      "/mock/session-dir/tasks",
    );
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/worktree", agentDir: "/mock/agent-dir" }),
    );
  });

  it("gives the resource loader the derived settings view, not the session's own", async () => {
    const sessionSettings = { marker: "session" };
    const loaderSettings = { marker: "loader" };
    io.createSettingsManager.mockReturnValue(sessionSettings);
    io.createLoaderSettingsManager.mockReturnValue(loaderSettings);

    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(io.createLoaderSettingsManager).toHaveBeenCalledWith(sessionSettings);
    expect(io.createResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({ settingsManager: loaderSettings }),
    );
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ settingsManager: sessionSettings }),
    );
  });

  it("creates the session's settings manager exactly once and reuses it", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(io.createSettingsManager).toHaveBeenCalledTimes(1);
    expect(io.createLoaderSettingsManager).toHaveBeenCalledTimes(1);
  });

  it("suppresses AGENTS.md/CLAUDE.md/APPEND_SYSTEM.md for subagents", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(io.createResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({
        noContextFiles: true,
        appendSystemPromptOverride: expect.any(Function),
      }),
    );
    const loaderOpts = io.createResourceLoader.mock.calls[0][0];
    expect(loaderOpts.appendSystemPromptOverride()).toEqual([]);
  });

  it("calls newSession with parentSession when parentSessionId is provided", async () => {
    await createSubagentSession(
      {
        snapshot: STUB_SNAPSHOT,
        type: "explore",
        parentSession: {
          parentSessionFile: "/sessions/parent.jsonl",
          parentSessionId: "parent-id-123",
        },
      },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    const sm = io.createSessionManager.mock.results[0].value;
    expect(sm.newSession).toHaveBeenCalledWith({ parentSession: "parent-id-123" });
  });
});

describe("createSubagentSession — lifecycle ordering", () => {
  let session: ReturnType<typeof createFactorySession>;
  let lifecycle: ReturnType<typeof createChildLifecycleMock>;

  beforeEach(() => {
    session = createFactorySession();
    io.createSession.mockResolvedValue({ session });
    lifecycle = createChildLifecycleMock();
  });

  it("emits spawning before session-created", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );

    expect(lifecycle.spawning).toHaveBeenCalledOnce();
    const spawnOrder = lifecycle.spawning.mock.invocationCallOrder[0];
    const createdOrder = lifecycle.sessionCreated.mock.invocationCallOrder[0];
    expect(spawnOrder).toBeLessThan(createdOrder);
  });

  it("emits session-created before bindExtensions()", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );

    expect(lifecycle.sessionCreated).toHaveBeenCalledOnce();
    const createdOrder = lifecycle.sessionCreated.mock.invocationCallOrder[0];
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    expect(createdOrder).toBeLessThan(bindOrder);
  });

  it("emits bound after bindExtensions()", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );

    expect(lifecycle.bound).toHaveBeenCalledOnce();
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    const boundOrder = lifecycle.bound.mock.invocationCallOrder[0];
    expect(bindOrder).toBeLessThan(boundOrder);
  });

  it("carries the session id and parent session id in bound", async () => {
    await createSubagentSession(
      {
        snapshot: STUB_SNAPSHOT,
        type: "explore",
        parentSession: {
          parentSessionFile: "/sessions/parent.jsonl",
          parentSessionId: "parent-session-42",
        },
      },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );

    expect(lifecycle.bound).toHaveBeenCalledWith({
      sessionId: "child-session-id",
      parentSessionId: "parent-session-42",
    });
  });

  it("carries the session id and parent session id in session-created", async () => {
    io.deriveSessionDir.mockReturnValue("/custom/session/dir");

    await createSubagentSession(
      {
        snapshot: STUB_SNAPSHOT,
        type: "explore",
        parentSession: {
          parentSessionFile: "/sessions/parent.jsonl",
          parentSessionId: "parent-session-42",
        },
      },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );

    expect(lifecycle.sessionCreated).toHaveBeenCalledWith({
      sessionId: "child-session-id",
      parentSessionId: "parent-session-42",
      cwd: STUB_SNAPSHOT.cwd,
    });
  });

  it("announces the effective cwd on session-created", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore", cwd: "/tmp/worktree" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );
    expect(lifecycle.sessionCreated).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/worktree" }),
    );
  });

  it("carries the agent id on every event, but no tool call id or handoff a service spawn did not give", async () => {
    const sub = await createSubagentSession(
      {
        snapshot: STUB_SNAPSHOT,
        type: "explore",
        agentId: "agent-7",
        parentSession: {
          parentSessionFile: "/sessions/parent.jsonl",
          parentSessionId: "parent-session-42",
        },
      },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );
    await sub.dispose();

    const identity = { sessionId: "child-session-id", agentId: "agent-7" };
    expect(lifecycle.sessionCreated).toHaveBeenCalledWith({
      ...identity,
      parentSessionId: "parent-session-42",
      cwd: STUB_SNAPSHOT.cwd,
    });
    expect(lifecycle.bound).toHaveBeenCalledWith({
      ...identity,
      parentSessionId: "parent-session-42",
    });
    expect(lifecycle.disposed).toHaveBeenCalledWith(identity);
  });

  it("does not emit completed or disposed during creation", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );

    expect(lifecycle.completed).not.toHaveBeenCalled();
    expect(lifecycle.disposed).not.toHaveBeenCalled();
  });
});

describe("createSubagentSession — dispose on creation failure", () => {
  it("disposes the session and emits disposed when bindExtensions throws, then rethrows", async () => {
    const session = createFactorySession();
    session.bindExtensions = vi.fn().mockRejectedValue(new Error("bind failed"));
    io.createSession.mockResolvedValue({ session });
    io.deriveSessionDir.mockReturnValue("/custom/session/dir");
    const lifecycle = createChildLifecycleMock();

    await expect(
      createSubagentSession(
        { snapshot: STUB_SNAPSHOT, type: "explore" },
        createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
      ),
    ).rejects.toThrow("bind failed");

    // session-created fired, so disposed must fire to avoid a registry leak.
    expect(lifecycle.sessionCreated).toHaveBeenCalledOnce();
    expect(lifecycle.disposed).toHaveBeenCalledOnce();
    expect(lifecycle.disposed).toHaveBeenCalledWith({ sessionId: "child-session-id" });
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("does not emit bound when bindExtensions throws", async () => {
    const session = createFactorySession();
    session.bindExtensions = vi.fn().mockRejectedValue(new Error("bind failed"));
    io.createSession.mockResolvedValue({ session });
    const lifecycle = createChildLifecycleMock();

    await expect(
      createSubagentSession(
        { snapshot: STUB_SNAPSHOT, type: "explore" },
        createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
      ),
    ).rejects.toThrow("bind failed");

    // The child never ran, so there is nothing to report about what its
    // extensions installed.
    expect(lifecycle.bound).not.toHaveBeenCalled();
  });

  it("shuts down the extensions that did initialize before the bind failed", async () => {
    const session = createFactorySession();
    session.bindExtensions = vi.fn().mockRejectedValue(new Error("bind failed"));
    io.createSession.mockResolvedValue({ session });

    await expect(
      createSubagentSession(
        { snapshot: STUB_SNAPSHOT, type: "explore" },
        createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
      ),
    ).rejects.toThrow("bind failed");

    expect(session.extensionRunner.emit).toHaveBeenCalledWith({
      type: "session_shutdown",
      reason: "quit",
    });
  });
});

describe("createSubagentSession — recursion guard", () => {
  // A child loads this extension too, so it registers the spawn tools during
  // bindExtensions. They are denied at the SDK boundary, which holds for the
  // child's whole life — a post-bind active-set filter would be undone by the
  // next tool-registry refresh (#725).

  it("denies this extension's spawn tools when creating the child session", async () => {
    arrangeFactory();

    await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "explore" }, defaultDeps());

    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeTools: ["subagent_start", "subagent_get", "subagent_steer"],
      }),
    );
  });

  it("leaves the child's active tool set untouched after bind", async () => {
    const session = arrangeFactory();

    await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "explore" }, defaultDeps());

    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
  });

  it("lets the orchestrator delegate and retain worker capabilities and todo", async () => {
    arrangeFactory();
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "orchestrate" },
      createSubagentSessionDeps({
        io,
        exec,
        registry: new AgentTypeRegistry(() => new Map()),
        listParentToolNames: () => [
          "read",
          "bash",
          "edit",
          "write",
          "todo_list",
          "todo_upsert",
          "todo_replace",
          "todo_remove",
          "todo_clear",
          "subagent_start",
          "subagent_get",
          "subagent_steer",
          "specialist",
        ],
      }),
    );
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          "read",
          "bash",
          "edit",
          "write",
          "todo_list",
          "todo_upsert",
          "todo_replace",
          "todo_remove",
          "todo_clear",
          "subagent_start",
          "subagent_get",
          "subagent_steer",
          "specialist",
        ],
        excludeTools: [],
      }),
    );
  });

  function orchestratorWith(overrides: Partial<AgentConfig>) {
    return {
      ...new AgentTypeRegistry(() => new Map()).resolveAgentConfig("orchestrate"),
      ...overrides,
    };
  }

  it("withholds delegation tools a profile names in tools without delegate", async () => {
    arrangeFactory();
    await createSubagentSession(
      {
        snapshot: STUB_SNAPSHOT,
        type: "orchestrate",
        agentConfig: orchestratorWith({
          delegate: undefined,
          toolNames: ["read", "subagent_start", "subagent_get", "subagent_steer"],
        }),
      },
      defaultDeps(),
    );
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ["read"],
        excludeTools: ["subagent_start", "subagent_get", "subagent_steer"],
      }),
    );
  });

  it("adds every delegation tool to an allowlist that names none of them", async () => {
    arrangeFactory();
    await createSubagentSession(
      {
        snapshot: STUB_SNAPSHOT,
        type: "orchestrate",
        agentConfig: orchestratorWith({ delegate: true, toolNames: ["read"] }),
      },
      defaultDeps(),
    );
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ["read", "subagent_start", "subagent_get", "subagent_steer"],
        excludeTools: [],
      }),
    );
  });

  it("lets an explicit exclusion win over delegate", async () => {
    arrangeFactory();
    await createSubagentSession(
      {
        snapshot: STUB_SNAPSHOT,
        type: "orchestrate",
        agentConfig: orchestratorWith({ delegate: true, toolNames: ["all", "-subagent_steer"] }),
      },
      defaultDeps(),
    );
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ["subagent_start", "subagent_get"],
        excludeTools: ["subagent_steer"],
      }),
    );
  });
});

describe("createSubagentSession — the core's own child tools", () => {
  // The SDK applies `tools` as an allowlist *before* building the registry and
  // runs every `customTools` entry through it, so a custom tool whose name is
  // missing from the allowlist is dropped with no error (#725). Both halves are
  // asserted separately so dropping either one fails a test.

  describe("when the run supplies an ask-back recorder", () => {
    it("appends pi-ask's ask to the allowlist the agent declared", async () => {
      arrangeFactory();

      await createSubagentSession(
        { snapshot: STUB_SNAPSHOT, type: "explore", askParent: vi.fn() },
        defaultDeps(),
      );

      expect(io.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ tools: ["read", "ask"] }),
      );
      const opts = io.createSession.mock.calls[0][0] as CreateSessionOptions;
      expect(opts.customTools).toEqual([]);
    });

    it("appends over an agent that declared no tools at all", async () => {
      arrangeFactory();

      await createSubagentSession(
        { snapshot: STUB_SNAPSHOT, type: "explore", askParent: vi.fn() },
        createSubagentSessionDeps({ io, exec, registry: createAgentLookup({ toolNames: [] }) }),
      );

      expect(io.createSession).toHaveBeenCalledWith(expect.objectContaining({ tools: ["ask"] }));
    });

    it("offers the recorder as the child's ask:route before its extensions bind, and withdraws it on dispose", async () => {
      arrangeFactory();
      const askParent = vi.fn<(question: string) => void>();
      const deps = defaultDeps();
      let sessionId = "";
      let routeAtBind: { record(question: string): void } | undefined;
      vi.mocked(deps.lifecycle.bound).mockImplementation((event) => {
        sessionId = event.sessionId;
        routeAtBind = service(event.sessionId, "ask:route");
      });

      const subagent = await createSubagentSession(
        { snapshot: STUB_SNAPSHOT, type: "explore", askParent },
        deps,
      );

      expect(routeAtBind).toBeDefined();
      routeAtBind!.record("Which config wins?");
      expect(askParent).toHaveBeenCalledWith("Which config wins?");
      await subagent.dispose();
      expect(service(sessionId, "ask:route")).toBeUndefined();
    });
  });

  describe("when the run supplies no callbacks", () => {
    it("leaves the agent's declared allowlist alone", async () => {
      arrangeFactory();

      await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "explore" }, defaultDeps());

      expect(io.createSession).toHaveBeenCalledWith(expect.objectContaining({ tools: ["read"] }));
    });

    it("installs no custom tools", async () => {
      arrangeFactory();

      await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "explore" }, defaultDeps());

      const opts = io.createSession.mock.calls[0][0] as CreateSessionOptions;
      expect(opts.customTools).toEqual([]);
    });
  });
});

describe("createSubagentSession — prompt inheritance", () => {
  /** The inherited-prompt argument the assembler handed the prompt builder. */
  function inheritedArgument() {
    return io.assemblerIO.buildAgentPrompt.mock.calls[0]?.[3];
  }

  it("hands the prompt builder the snapshot's portable parts", async () => {
    arrangeFactory();

    await createSubagentSession(
      {
        snapshot: { ...STUB_SNAPSHOT, portablePrompt: "You are a specialist." },
        type: "explore",
      },
      defaultDeps(),
    );

    expect(inheritedArgument()?.portablePrompt).toBe("You are a specialist.");
  });

  it("applies the strategy the deps' resolver returns", async () => {
    arrangeFactory();

    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore" },
      createSubagentSessionDeps({
        io,
        exec,
        registry: mockAgentLookup,
        resolvePromptInheritance: () => "portable",
      }),
    );

    expect(inheritedArgument()?.strategy).toBe("portable");
  });
});

/** The names of the built-ins the child's resource loader was handed. */
function loadedBuiltinNames(): string[] | undefined {
  const opts = io.createResourceLoader.mock.calls[0]?.[0] as ResourceLoaderOptions | undefined;
  return opts?.extensionFactories?.map((extension) =>
    typeof extension === "function" ? "<factory>" : extension.name,
  );
}

describe("createSubagentSession — Pi built-in extensions", () => {
  it("hands the loader the built-ins the agent's tools call for", async () => {
    arrangeFactory();

    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore" },
      createSubagentSessionDeps({
        io,
        exec,
        registry: createAgentLookup({ toolNames: ["read", "codemode", "mcp__github__get_issue"] }),
      }),
    );

    expect(loadedBuiltinNames()).toEqual(["codemode", "mcp"]);
  });

  it("adds the profile guards after the built-ins when the agent declares a reminder", async () => {
    arrangeFactory();

    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore" },
      createSubagentSessionDeps({
        io,
        exec,
        registry: createAgentLookup({ toolNames: ["read", "codemode"], reminder: "Delegate." }),
      }),
    );

    expect(loadedBuiltinNames()).toEqual(["codemode", "<factory>"]);
  });

  it("gates the child's reminder on the deps' setting, read per request", async () => {
    arrangeFactory();
    let enabled = false;

    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore" },
      createSubagentSessionDeps({
        io,
        exec,
        registry: createAgentLookup({ toolNames: ["read"], reminder: "Delegate." }),
        remindersEnabled: () => enabled,
      }),
    );

    const opts = io.createResourceLoader.mock.calls[0]?.[0] as ResourceLoaderOptions;
    const factory = opts.extensionFactories?.at(-1);
    const handlers = new Map<string, Function>();
    if (typeof factory !== "function") throw new Error("expected the guards factory");
    void factory({ on: (name: string, fn: Function) => handlers.set(name, fn) } as never);
    const context = handlers.get("context")!;
    const messages = [{ role: "user", content: "hi", timestamp: 0 }];
    expect(context({ messages })).toBeUndefined();
    enabled = true;
    expect(context({ messages }).messages).toHaveLength(2);
  });

  it("adds the profile guards for reserved tools, which stay in the child's allowlist", async () => {
    arrangeFactory();

    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore" },
      createSubagentSessionDeps({
        io,
        exec,
        registry: createAgentLookup({ toolNames: ["read", "write"], reservedTools: ["write"] }),
      }),
    );

    expect(loadedBuiltinNames()).toEqual(["<factory>"]);
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ tools: expect.arrayContaining(["read", "write"]) }),
    );
  });

  it("hands the loader no built-ins when the agent's tools call for none", async () => {
    arrangeFactory();

    await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "explore" }, defaultDeps());

    expect(loadedBuiltinNames()).toEqual([]);
  });
});

describe("createSubagentSession — all tools and MCP patterns", () => {
  it("inherits all available parent tools for a profile without a tools declaration", async () => {
    arrangeFactory();
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "general-purpose" },
      createSubagentSessionDeps({
        io,
        exec,
        registry: createAgentLookup({ toolNames: undefined }),
        listParentToolNames: () => [
          "read",
          "bash",
          "edit",
          "codemode",
          "tool_search",
          "mcp__github__get_issue",
          "my_extension",
        ],
      }),
    );
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          "read",
          "bash",
          "edit",
          "codemode",
          "tool_search",
          "mcp__github__get_issue",
          "my_extension",
        ],
        excludeTools: ["subagent_start", "subagent_get", "subagent_steer"],
      }),
    );
    expect(loadedBuiltinNames()).toEqual(["codemode", "tool-search", "mcp"]);
  });

  it("subtracts exact and MCP tools from all and retains other extensions", async () => {
    arrangeFactory();
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "general-purpose" },
      createSubagentSessionDeps({
        io,
        exec,
        registry: createAgentLookup({ toolNames: ["all", "-bash", "-mcp__github__*"] }),
        listParentToolNames: () => [
          "read",
          "bash",
          "codemode",
          "mcp__github__a",
          "mcp__gitlab__b",
          "my_extension",
        ],
      }),
    );
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ["read", "codemode", "mcp__gitlab__b", "my_extension"],
      }),
    );
    expect(loadedBuiltinNames()).toEqual(["codemode", "mcp"]);
  });

  it("does not expose subagent spawning tools even when all includes them", async () => {
    arrangeFactory();
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "general-purpose" },
      createSubagentSessionDeps({
        io,
        exec,
        registry: createAgentLookup({ toolNames: ["all"] }),
        listParentToolNames: () => ["read", "subagent_start", "subagent_steer", "subagent_get"],
      }),
    );
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeTools: ["subagent_start", "subagent_get", "subagent_steer"],
      }),
    );
  });

  const PARENT_TOOLS = ["read", "mcp__github__a", "mcp__github__b", "mcp__gitlab__c"];

  function depsDeclaring(toolNames: string[], parentTools: string[]) {
    return createSubagentSessionDeps({
      io,
      exec,
      registry: createAgentLookup({ toolNames }),
      listParentToolNames: () => parentTools,
    });
  }

  it("admits the parent's tools a pattern matches, and loads MCP for them", async () => {
    arrangeFactory();

    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore" },
      depsDeclaring(["read", "mcp__github__*"], PARENT_TOOLS),
    );

    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ tools: ["read", "mcp__github__a", "mcp__github__b"] }),
    );
    expect(loadedBuiltinNames()).toEqual(["mcp"]);
  });

  it("admits nothing and loads no MCP for a pattern the parent's tools do not match", async () => {
    arrangeFactory();

    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore" },
      depsDeclaring(["read", "mcp__github__*"], ["read", "mcp__gitlab__c"]),
    );

    expect(io.createSession).toHaveBeenCalledWith(expect.objectContaining({ tools: ["read"] }));
    expect(loadedBuiltinNames()).toEqual([]);
  });
});
