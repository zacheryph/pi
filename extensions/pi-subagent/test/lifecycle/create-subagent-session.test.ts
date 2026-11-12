import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { service } from "#session-tree";
import { WORK_PARENT_SERVICE, type WorkParent } from "#work";
import { resetSessionTree } from "#test-helpers";
import { WORK_ENTRY, WORK_LOST, WORK_SERVICE, type WorkHost } from "#work";
import type {
  CreateSessionOptions,
  ResourceLoaderOptions,
} from "#src/lifecycle/create-subagent-session";
import { createSubagentSession, StaleSessionError } from "#src/lifecycle/create-subagent-session";
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

    it("tells the child's extensions it is a reload when the parent reloaded: the one reason pi-job keeps jobs for", async () => {
      await createSubagentSession(
        {
          snapshot: STUB_SNAPSHOT,
          type: "explore",
          cwd: "/worktree",
          transcriptPath: "/old-parent/tasks/agent.jsonl",
          startReason: "reload",
        },
        createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
      );
      expect(io.createSession.mock.calls[0][0]).toMatchObject({
        sessionStartEvent: { type: "session_start", reason: "reload" },
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

describe("createSubagentSession — handoff tool requirements", () => {
  function prepare(required = ["todo_list", "todo_upsert"], toolNames = ["read"]) {
    const session = arrangeFactory();
    session.getActiveToolNames.mockReturnValue([...toolNames, ...required]);
    const deps = createSubagentSessionDeps({
      io,
      exec,
      registry: createAgentLookup({ toolNames }),
    });
    deps.lifecycle.prepare.mockReturnValue(required);
    return { session, deps };
  }

  it.each([["read"], ["none"]])(
    "adds requirements to the SDK allowlist for profile %j",
    async (...toolNames) => {
      const { deps } = prepare(["todo_list", "todo_upsert"], toolNames);
      const handoff = { todo: { keys: ["audit"] } };
      await createSubagentSession(
        {
          snapshot: STUB_SNAPSHOT,
          type: "explore",
          handoff,
          agentId: "worker",
          cwd: "/worktree",
          parentSession: { parentSessionId: "parent", toolCallId: "spawn-call" },
        },
        deps,
      );
      expect(deps.lifecycle.prepare).toHaveBeenCalledWith({
        agentName: "explore",
        agentId: "worker",
        parentSessionId: "parent",
        toolCallId: "spawn-call",
        cwd: "/worktree",
        handoff,
      });
      expect(io.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [...toolNames.filter((name) => name !== "none"), "todo_list", "todo_upsert"],
        }),
      );
      expect(deps.lifecycle.prepare.mock.invocationCallOrder[0]).toBeLessThan(
        io.createSession.mock.invocationCallOrder[0],
      );
    },
  );

  it.each([
    ["todo_upsert", ["read", "-todo_upsert"]],
    ["mcp__test__read", ["read", "-mcp__test__*"]],
    ["subagent_start", ["read"]],
  ])("refuses excluded requirements without creating a session: %s", async (name, toolNames) => {
    const { deps } = prepare([name], toolNames);
    await expect(
      createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "explore" }, deps),
    ).rejects.toThrow(`required tools excluded: ${name}`);
    expect(io.createSession).not.toHaveBeenCalled();
  });

  it("loads built-in extensions needed by a contributed tool", async () => {
    const { deps } = prepare(["codemode"]);
    await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "explore" }, deps);
    expect(loadedBuiltinNames()).toEqual(["codemode"]);
  });

  it("deduplicates tools already selected by the profile", async () => {
    const { deps } = prepare(["todo_list"], ["read", "todo_list"]);
    await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "explore" }, deps);
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ tools: ["read", "todo_list"] }),
    );
  });

  it("disposes a child whose extensions did not make required tools active", async () => {
    const { session, deps } = prepare();
    session.getActiveToolNames.mockReturnValue(["read", "todo_list"]);
    await expect(
      createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "explore" }, deps),
    ).rejects.toThrow("required tools unavailable: todo_upsert");
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(deps.lifecycle.disposed).toHaveBeenCalledOnce();
    expect(deps.lifecycle.bound).not.toHaveBeenCalled();
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
        excludeTools: ["subagent_start", "subagent_get", "subagent_send"],
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
          "subagent_send",
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
          "subagent_send",
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
          toolNames: ["read", "subagent_start", "subagent_get", "subagent_send"],
        }),
      },
      defaultDeps(),
    );
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ["read"],
        excludeTools: ["subagent_start", "subagent_get", "subagent_send"],
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
        tools: ["read", "subagent_start", "subagent_get", "subagent_send"],
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
        agentConfig: orchestratorWith({ delegate: true, toolNames: ["all", "-subagent_send"] }),
      },
      defaultDeps(),
    );
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ["subagent_start", "subagent_get"],
        excludeTools: ["subagent_send"],
      }),
    );
  });
});

describe("createSubagentSession — the core's own child tools", () => {
  // The SDK applies `tools` as an allowlist *before* building the registry and
  // runs every `customTools` entry through it, so a custom tool whose name is
  // missing from the allowlist is dropped with no error (#725). Both halves are
  // asserted separately so dropping either one fails a test.

  describe("when the run supplies a way to announce a question", () => {
    it("appends pi-ask's ask to the allowlist the agent declared", async () => {
      arrangeFactory();

      await createSubagentSession(
        { snapshot: STUB_SNAPSHOT, type: "explore", announceQuestion: vi.fn() },
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
        { snapshot: STUB_SNAPSHOT, type: "explore", announceQuestion: vi.fn() },
        createSubagentSessionDeps({ io, exec, registry: createAgentLookup({ toolNames: [] }) }),
      );

      expect(io.createSession).toHaveBeenCalledWith(expect.objectContaining({ tools: ["ask"] }));
    });

    // Rewritten by roadmap step 10 (was: offered the recorder as the child's `ask:route` service,
    // whose `record(question)` stored the question on the agent). The service is now the child's
    // link to the item its parent holds for it: `work:parent`, whose `question(text)` tells the
    // parent. The question itself is an item in the child's own work host, opened by pi-ask.
    it("offers the child a link to its parent as work:parent before its extensions bind, and withdraws it on dispose", async () => {
      arrangeFactory();
      const announceQuestion = vi.fn<(question: string) => void>();
      const deps = defaultDeps();
      let sessionId = "";
      let linkAtBind: WorkParent | undefined;
      vi.mocked(deps.lifecycle.bound).mockImplementation((event) => {
        sessionId = event.sessionId;
        linkAtBind = service(event.sessionId, WORK_PARENT_SERVICE);
      });

      const subagent = await createSubagentSession(
        { snapshot: STUB_SNAPSHOT, type: "explore", announceQuestion },
        deps,
      );

      expect(linkAtBind).toBeDefined();
      linkAtBind!.question("Which config wins?");
      expect(announceQuestion).toHaveBeenCalledWith("Which config wins?");
      expect(service(sessionId, "ask:route")).toBeUndefined(); // the old record path is gone
      await subagent.dispose();
      expect(service(sessionId, WORK_PARENT_SERVICE)).toBeUndefined();
    });

    it("offers no link to a parent when the run has no way to announce a question", async () => {
      arrangeFactory();
      const deps = defaultDeps();
      let sessionId = "";
      vi.mocked(deps.lifecycle.bound).mockImplementation(
        (event) => void (sessionId = event.sessionId),
      );

      await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "explore" }, deps);

      expect(service(sessionId, WORK_PARENT_SERVICE)).toBeUndefined();
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

  it("adds the reserved-tools guard, and keeps those tools in the child's allowlist", async () => {
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
        excludeTools: ["subagent_start", "subagent_get", "subagent_send"],
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
        listParentToolNames: () => ["read", "subagent_start", "subagent_send", "subagent_get"],
      }),
    );
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeTools: ["subagent_start", "subagent_get", "subagent_send"],
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

describe("createSubagentSession — the child's managed work host", () => {
  // Every stub child here has the same session id: forget what the last test offered under it.
  beforeEach(resetSessionTree);
  const policy = () => ({ wake: vi.fn(), changed: vi.fn() });

  it("offers a work host under the child's session id before its extensions bind", async () => {
    const session = arrangeFactory();
    const deps = defaultDeps();
    let atBind: WorkHost | undefined;
    session.bindExtensions.mockImplementation(async () => {
      atBind = service<WorkHost>("child-session-id", WORK_SERVICE);
    });

    const subagent = await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore", work: policy() },
      deps,
    );

    expect(atBind).toBeDefined();
    // The one the session reports its open items from.
    const item = atBind!.open({ owner: "test", kind: "job", label: "CI" });
    expect(subagent.openWork().map((view) => view.id)).toEqual([item.id]);
  });

  it("persists the child's open items in the child's own session file", async () => {
    arrangeFactory();
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore", work: policy() },
      defaultDeps(),
    );
    const store = io.createSessionManager.mock.results[0].value as { appendCustomEntry: Mock };
    service<WorkHost>("child-session-id", WORK_SERVICE)!.open({
      owner: "test",
      kind: "job",
      label: "CI",
    });
    expect(store.appendCustomEntry).toHaveBeenCalledWith(
      WORK_ENTRY,
      expect.objectContaining({ op: "open", label: "CI" }),
    );
  });

  it("withdraws the host and forgets the items when the session is disposed", async () => {
    arrangeFactory();
    const subagent = await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore", work: policy() },
      defaultDeps(),
    );
    service<WorkHost>("child-session-id", WORK_SERVICE)!.open({
      owner: "test",
      kind: "job",
      label: "CI",
    });
    await subagent.dispose();
    expect(service("child-session-id", WORK_SERVICE)).toBeUndefined();
    expect(subagent.openWork()).toEqual([]);
  });

  it("loads the extension that wires the child's run boundaries to its host", async () => {
    arrangeFactory();
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore", work: policy() },
      defaultDeps(),
    );
    expect(loadedBuiltinNames()).toEqual(["<factory>"]);
  });

  it("reports what a reopened transcript left open as lost, once its extensions have bound", async () => {
    const session = arrangeFactory();
    const manager = {
      newSession: vi.fn(),
      getSessionFile: vi.fn().mockReturnValue("/old/tasks/agent.jsonl"),
      getSessionId: vi.fn().mockReturnValue("reopened-session-id"),
      getBranch: vi.fn().mockReturnValue([
        {
          type: "custom",
          customType: WORK_ENTRY,
          data: { v: 1, op: "open", id: "old", owner: "pi-job", kind: "watch", label: "CI", at: 1 },
        },
      ]),
      appendCustomEntry: vi.fn().mockReturnValue("entry"),
    };
    io.openSessionManager.mockReturnValue(manager);
    const order: string[] = [];
    session.bindExtensions.mockImplementation(async () => void order.push("bind"));
    session.sendCustomMessage.mockImplementation(async (message: { customType: string }) => {
      order.push(message.customType);
    });
    const wake = vi.fn();

    const subagent = await createSubagentSession(
      {
        snapshot: STUB_SNAPSHOT,
        type: "explore",
        transcriptPath: "/old/tasks/agent.jsonl",
        work: { wake, changed: vi.fn() },
      },
      defaultDeps(),
    );

    // Offered to its owners during their session_start, lost after; nothing is woken.
    expect(order).toEqual(["bind", WORK_LOST]);
    expect(session.sendCustomMessage).toHaveBeenCalledWith(expect.anything(), {
      triggerTurn: false,
    });
    expect(wake).not.toHaveBeenCalled();
    expect(subagent.openWork()).toEqual([]);
  });

  it("gives a session built without a policy no host and no wiring", async () => {
    arrangeFactory();
    const subagent = await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "explore" },
      defaultDeps(),
    );
    expect(service("child-session-id", WORK_SERVICE)).toBeUndefined();
    expect(subagent.openWork()).toEqual([]);
    expect(loadedBuiltinNames()).toEqual([]);
  });
});

describe("createSubagentSession — a creation that was abandoned meanwhile", () => {
  beforeEach(resetSessionTree);
  const policy = () => ({ wake: vi.fn(), changed: vi.fn(), lost: vi.fn() });
  const leftOpen = {
    v: 1,
    op: "open",
    id: "old",
    owner: "pi-job",
    kind: "watch",
    label: "CI",
    at: 1,
  };

  /** A reopened transcript that holds one open item, which a stale creation must leave alone. */
  function reopened() {
    const session = arrangeFactory();
    const appended: unknown[] = [];
    const manager = {
      newSession: vi.fn(),
      getSessionFile: () => "/old/tasks/agent.jsonl",
      getSessionId: () => "child-session-id",
      getBranch: () => [{ type: "custom", customType: WORK_ENTRY, data: leftOpen }],
      appendCustomEntry: vi.fn((_type: string, data: unknown) => {
        appended.push(data);
        return "e";
      }),
    };
    io.openSessionManager.mockReturnValue(manager);
    return { session, appended };
  }
  const params = (isStale: () => boolean) => ({
    snapshot: STUB_SNAPSHOT,
    type: "explore" as const,
    cwd: "/worktree",
    transcriptPath: "/old/tasks/agent.jsonl",
    work: policy(),
    isStale,
  });

  it("settles nothing and writes nothing when the extensions finish starting after it was abandoned", async () => {
    const { session, appended } = reopened();
    let stale = false;
    session.bindExtensions.mockImplementation(async () => {
      stale = true; // the bound passed while the extensions were starting
    });
    const lifecycle = createChildLifecycleMock();
    await expect(
      createSubagentSession(
        params(() => stale),
        createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
      ),
    ).rejects.toBeInstanceOf(StaleSessionError);

    // Not one write to the transcript a newer session owns: no lost close, no lost message.
    expect(appended).toEqual([]);
    expect(session.sendCustomMessage).not.toHaveBeenCalled();
    // The session is discarded, but never announced as disposed: its id is the live agent's now.
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(lifecycle.disposed).not.toHaveBeenCalled();
    expect(lifecycle.bound).not.toHaveBeenCalled();
    expect(service("child-session-id", WORK_SERVICE)).toBeUndefined();
  });

  it("offers nothing under the session id when it was abandoned before the session was built", async () => {
    const { session } = reopened();
    const newer = { open: vi.fn(), adopt: vi.fn(), list: vi.fn() };
    // A newer session already holds the id.
    const { provide } = await import("#session-tree");
    provide("child-session-id", WORK_SERVICE, newer);
    await expect(
      createSubagentSession(
        params(() => true),
        defaultDeps(),
      ),
    ).rejects.toBeInstanceOf(StaleSessionError);
    expect(service("child-session-id", WORK_SERVICE)).toBe(newer);
    expect(session.bindExtensions).not.toHaveBeenCalled();
  });

  it("does not clobber a newer session's work host when the abandoned one is disposed", async () => {
    reopened();
    const newer = { open: vi.fn(), adopt: vi.fn(), list: vi.fn() };
    const { provide } = await import("#session-tree");
    let stale = false;
    const session = arrangeFactory();
    session.bindExtensions.mockImplementation(async () => {
      // A newer session took the id while this one's extensions were starting.
      provide("child-session-id", WORK_SERVICE, newer);
      stale = true;
    });
    await expect(
      createSubagentSession(
        params(() => stale),
        defaultDeps(),
      ),
    ).rejects.toBeInstanceOf(StaleSessionError);
    expect(service("child-session-id", WORK_SERVICE)).toBe(newer);
  });

  it("is untouched when nobody abandoned it: the host settles its startup as before", async () => {
    const { session, appended } = reopened();
    await createSubagentSession(
      params(() => false),
      defaultDeps(),
    );
    expect(appended).toContainEqual(expect.objectContaining({ op: "close", reason: "lost" }));
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: WORK_LOST }),
      { triggerTurn: false },
    );
  });
});
