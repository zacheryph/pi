import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { fakePi, resetSessionTree } from "#test-helpers";
import type { GitConfig } from "#src/config";
import { GIT_SNAPSHOT_EVENT, type GitSnapshotEvent } from "#src/events";
import { service } from "#session-tree";
import piGit, { SERVICE_NAME } from "#src/index";
import { GhUnavailable, type GhRunner } from "#src/status";
import { LEDGER_TYPE, type WorktreeRecord } from "#src/ledger";
import { commit, run, sandbox, type Sandbox } from "#test/support/repos";

/** One wall clock for every session in a test, as in a real process. */
let clock = 1_000;
/** While true, every session reads the same millisecond, as within one synchronous burst. */
let frozen = false;

/** A fake ExtensionAPI and session for one pi-git instance. */
function harness(options: {
  sessionId: string;
  cwd: string;
  root: string;
  entries?: unknown[];
  trackReferenced?: boolean;
  loadConfig?: () => GitConfig;
  runGh?: GhRunner;
}) {
  const entries: unknown[] = [...(options.entries ?? [])];
  const snapshots: GitSnapshotEvent[] = [];
  const fake = fakePi({
    appendEntry: vi.fn((customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
    ),
  });
  fake.api.events.on(GIT_SNAPSHOT_EVENT, (data) => snapshots.push(data as GitSnapshotEvent));
  piGit(fake.api, {
    loadConfig:
      options.loadConfig ??
      (() => ({
        worktreeRoot: options.root,
        trackReferenced: options.trackReferenced ?? true,
        watchIntervalSeconds: 60,
      })),
    now: () => (frozen ? clock : (clock += 1)),
    ...(options.runGh ? { runGh: options.runGh } : {}),
    retry: { sleep: async () => undefined },
  });
  const ui = {
    notify: vi.fn(),
    select: vi.fn(async (_title: string, items: string[]) => items[0]),
    confirm: vi.fn(async () => true),
  };
  const ctx = {
    cwd: options.cwd,
    hasUI: true,
    mode: "print",
    ui,
    sessionManager: {
      getSessionId: () => options.sessionId,
      getEntries: () => entries,
      // The session's work host (packages/pi-work) reads its open items from the branch.
      getBranch: () => entries,
    },
    isIdle: () => true,
  };
  const fire = (event: string, data: object = {}) => fake.emit(event, data, ctx);
  const tool = (name: string, params: Record<string, unknown>) =>
    fake.runTool(name, params, ctx) as Promise<{ content: { text: string }[]; details: unknown }>;
  const ledger = () =>
    entries
      .filter((entry) => (entry as { customType?: string }).customType === LEDGER_TYPE)
      .map((entry) => (entry as { data: WorktreeRecord }).data);
  const { pi, tools, commands } = fake;
  return { pi, ctx, ui, tools, commands, entries, snapshots, fire, tool, ledger };
}

let box: Sandbox;
beforeEach(() => {
  box = sandbox(onTestFinished);
  clock = 1_000;
  frozen = false;
});
afterEach(resetSessionTree);

const start = async (sessionId = "parent", entries?: unknown[]) => {
  const h = harness({ sessionId, cwd: box.dir, root: box.root, entries });
  await h.fire("session_start");
  return h;
};

describe("pi-git registration", () => {
  it("registers its tools, command and session handlers", async () => {
    const h = await start();
    expect([...h.tools.keys()]).toEqual([
      "git_worktree_create",
      "git_worktree_list",
      "git_worktree_remove",
      "git_pr_list",
      "git_pr_status",
      "git_pr_watch",
    ]);
    expect(h.commands.has("git:refresh")).toBe(true);
    expect(h.commands.has("git:worktrees")).toBe(true);
    expect(h.commands.has("git:prs")).toBe(true);
    for (const event of [
      "session_start",
      "session_tree",
      "session_compact",
      "session_shutdown",
      "context",
      "tool_result",
    ])
      expect(h.pi.on).toHaveBeenCalledWith(event, expect.any(Function));
  });
});

describe("context card", () => {
  const CARD = "Pull requests and worktrees in this session";
  type Message = { role: string; customType?: string; content?: string; display?: boolean };
  const user: Message = { role: "user", content: "hi" };
  const prEntry = (number = 12) => ({
    type: "custom",
    customType: LEDGER_TYPE,
    data: {
      v: 1,
      kind: "pr",
      key: `github.com/acme/api#${number}`,
      host: "github.com",
      owner: "acme",
      repo: "api",
      number,
      url: `https://github.com/acme/api/pull/${number}`,
      origin: "created",
      title: "Add login",
      status: { state: "open", observedAt: 1, source: "bash" },
      calls: [],
      createdAt: 1,
      updatedAt: 1,
    },
  });
  /** What the next request would hold, given the messages it starts from. */
  const contextOf = async (h: Awaited<ReturnType<typeof start>>, messages = [user]) => {
    const context = [...h.pi.on.mock.calls].find(([event]) => event === "context")!;
    const handler = context[1] as (
      event: unknown,
      ctx: unknown,
    ) => Promise<{ messages: Message[] } | undefined>;
    return (await handler({ type: "context", messages }, h.ctx))?.messages ?? messages;
  };
  const cards = (messages: Message[]) => messages.filter((m) => m.customType === "git:context");
  it("uses the worktree repository's remote rather than its directory name", async () => {
    run(box.api, "remote", "add", "origin", "https://github.com/acme/api.git");
    const h = await start();
    await h.tool("git_worktree_create", { repo: "src/api", branch: "fix" });
    const path = join(box.root, "api", "fix");
    h.pi.events.emit("subagent:session:created", { agentId: "agent-1", cwd: path });
    const entry = prEntry();
    h.entries.push({
      ...entry,
      data: {
        ...entry.data,
        owner: "other-org",
        key: "github.com/other-org/api#12",
        status: { state: "merged", headRef: "fix", observedAt: 1, source: "bash" },
      },
    });
    await h.fire("session_compact");
    expect(cards(await contextOf(h))[0]?.content).toContain(`worktree ${path} on fix: no PR yet`);
    h.entries.push({
      ...entry,
      data: { ...entry.data, status: { ...entry.data.status, headRef: "fix" } },
    });
    expect(cards(await contextOf(h))[0]?.content).toContain(
      `PR 12 "Add login": open, worktree ${path}`,
    );
  });

  it("arms the card for a worktree with a closed PR even without recorded agents", async () => {
    run(box.api, "remote", "add", "origin", "https://github.com/acme/api.git");
    const h = await start();
    await h.tool("git_worktree_create", { repo: "src/api", branch: "fix" });
    const entry = prEntry();
    h.entries.push({
      ...entry,
      data: {
        ...entry.data,
        status: { state: "closed", headRef: "fix", observedAt: 1, source: "bash" },
      },
    });
    for (const event of ["session_compact", "session_tree", "session_start"]) {
      await h.fire(event);
      expect(cards(await contextOf(h))[0]?.content).toContain(
        `worktree ${join(box.root, "api", "fix")} on fix: no open PR`,
      );
    }
  });
  const listResult = (toolName: string, extra: Record<string, unknown> = {}) => ({
    toolName,
    toolCallId: "call-1",
    input: {},
    content: [{ type: "text", text: "" }],
    isError: false,
    ...extra,
  });

  it("gives a session with no ledger entries no card, and adds none for new work", async () => {
    const h = await start();
    expect(await contextOf(h)).toEqual([user]);
    await h.fire("session_compact");
    expect(await contextOf(h)).toEqual([user]);
    await h.tool("git_worktree_create", { repo: "src/api", branch: "feat/x" });
    h.pi.events.emit("subagent:session:created", {
      agentId: "agent-1",
      cwd: join(box.root, "api", "feat-x"),
    });
    expect(await contextOf(h)).toEqual([user]);
  });

  it("appends one hidden card last after a resume or reload, without touching the transcript", async () => {
    const h = await start("parent", [prEntry()]);
    const before = h.entries.length;
    const messages = await contextOf(h);
    expect(messages.slice(0, -1)).toEqual([user]);
    expect(messages.at(-1)).toMatchObject({
      role: "custom",
      customType: "git:context",
      display: false,
      content: expect.stringContaining('PR 12 "Add login": open'),
    });
    // A later request replaces the previous card instead of stacking another.
    const again = await contextOf(h, messages as (typeof user)[]);
    expect(cards(again)).toHaveLength(1);
    expect(again.at(-1)?.content).toContain(CARD);
    expect(h.entries).toHaveLength(before);
  });

  it("appears after a compaction once there is something to restore", async () => {
    const h = await start();
    h.entries.push(prEntry());
    expect(await contextOf(h)).toEqual([user]);
    await h.fire("session_compact");
    expect(cards(await contextOf(h))).toHaveLength(1);
  });

  it.each(["git_pr_list", "git_worktree_list"])("stops after a %s result", async (name) => {
    const h = await start("parent", [prEntry()]);
    expect(cards(await contextOf(h))).toHaveLength(1);
    await h.fire("tool_result", listResult(name));
    const messages = await contextOf(h);
    expect(cards(messages)).toEqual([]);
    // A card left in the messages is stripped too.
    const stale = { role: "custom", customType: "git:context", content: "old" };
    expect(await contextOf(h, [user, stale as typeof user])).toEqual([user]);
  });

  it("keeps showing past a failed or nested list and any other tool", async () => {
    const h = await start("parent", [prEntry()]);
    await h.fire("tool_result", listResult("git_pr_list", { isError: true }));
    await h.fire("tool_result", listResult("git_worktree_list", { parentToolCallId: "outer" }));
    await h.fire("tool_result", listResult("read"));
    await h.fire("tool_result", listResult("git_pr_status"));
    expect(cards(await contextOf(h))).toHaveLength(1);
  });

  it("comes back after a compaction, /tree or reload that follows a list result", async () => {
    const h = await start("parent", [prEntry()]);
    for (const event of ["session_compact", "session_tree", "session_start"]) {
      await h.fire("tool_result", listResult("git_pr_list"));
      expect(cards(await contextOf(h))).toEqual([]);
      await h.fire(event);
      expect(cards(await contextOf(h))).toHaveLength(1);
    }
  });

  it("shows what the ledger holds now, not what it held at the event", async () => {
    const h = await start("parent", [prEntry()]);
    h.entries.push({
      ...prEntry(),
      data: { ...prEntry().data, status: { state: "merged", observedAt: 2, source: "bash" } },
    });
    expect(await contextOf(h)).toEqual([user]);
  });

  it("stops at shutdown", async () => {
    const h = await start("parent", [prEntry()]);
    await h.fire("session_shutdown");
    expect(await contextOf(h)).toEqual([user]);
  });
});

describe("ledger", () => {
  it("records a created worktree, publishes it, and says how to hand it to a subagent", async () => {
    const h = await start();
    const result = await h.tool("git_worktree_create", { repo: "src/api", branch: "feat/x" });
    const path = join(box.root, "api", "feat-x");
    expect(result.content[0].text).toContain(`Created worktree ${path} on branch feat/x`);
    expect(result.content[0].text).toContain(`subagent_start and cwd: "${path}"`);
    expect(h.ledger()).toEqual([
      expect.objectContaining({ path, branch: "feat/x", state: "active" }),
    ]);
    expect(h.snapshots.at(-1)?.worktrees.map((w) => w.path)).toEqual([path]);
  });

  it("restores the ledger after a reload and lists it with its git status", async () => {
    const first = await start();
    await first.tool("git_worktree_create", { repo: "src/api", branch: "feat/x" });
    const path = join(box.root, "api", "feat-x");
    writeFileSync(join(path, "wip.txt"), "x");

    const reloaded = await start("parent", first.entries);
    expect(reloaded.snapshots[0].worktrees.map((w) => w.path)).toEqual([path]);
    const list = await reloaded.tool("git_worktree_list", {});
    expect(list.content[0].text).toBe(`- ${path}\n  api @ feat/x — uncommitted changes`);
  });

  it("restores on /tree from every branch of the session, not only the current one", async () => {
    const h = await start();
    await h.tool("git_worktree_create", { repo: "src/api", branch: "feat/x" });
    await h.fire("session_tree");
    expect(h.snapshots.at(-1)?.worktrees).toHaveLength(1);
  });

  it("notes each subagent that starts in a worktree or its workspace", async () => {
    const h = await start();
    await h.tool("git_worktree_create", { repo: "src/api", branch: "auth", workspace: "auth" });
    await h.tool("git_worktree_create", { repo: "src/web", branch: "auth", workspace: "auth" });
    await h.tool("git_worktree_create", { repo: "src/api", branch: "solo" });

    h.pi.events.emit("subagent:session:created", {
      sessionId: "child-1",
      agentId: "agent-ws",
      cwd: join(box.root, "auth"),
    });
    h.pi.events.emit("subagent:session:created", {
      sessionId: "child-2",
      agentId: "agent-solo",
      cwd: join(box.root, "api", "solo", "src"),
    });
    h.pi.events.emit("subagent:session:created", {
      sessionId: "child-3",
      agentId: "agent-elsewhere",
      cwd: box.dir,
    });

    const agents = Object.fromEntries(
      h.snapshots.at(-1)!.worktrees.map((w) => [w.path.slice(box.root.length + 1), w.agents]),
    );
    expect(agents).toEqual({
      "auth/api": ["agent-ws"],
      "auth/web": ["agent-ws"],
      "api/solo": ["agent-solo"],
    });
  });

  it("marks a worktree deleted outside Pi as missing", async () => {
    const h = await start();
    await h.tool("git_worktree_create", { repo: "src/api", branch: "gone" });
    rmSync(join(box.root, "api", "gone"), { recursive: true, force: true });
    const list = await h.tool("git_worktree_list", {});
    expect(list.content[0].text).toContain("missing: deleted outside Pi");
    expect(h.ledger().at(-1)?.state).toBe("missing");
  });
});

describe("background refresh", () => {
  it("keeps the service withdrawn and card hidden when shutdown interrupts startup", async () => {
    const first = await start();
    await first.tool("git_worktree_create", { repo: "src/api", branch: "shutdown" });
    first.pi.events.emit("subagent:session:created", {
      agentId: "agent-1",
      cwd: join(box.root, "api", "shutdown"),
    });
    const h = harness({
      sessionId: "interrupted",
      cwd: box.dir,
      root: box.root,
      entries: first.entries,
    });
    const starting = h.fire("session_start");
    await h.fire("session_shutdown");
    await starting;
    expect(service("interrupted", SERVICE_NAME)).toBeUndefined();
    const context = [...h.pi.on.mock.calls].find(([event]) => event === "context")!;
    expect(await context[1]({ type: "context", messages: [] }, h.ctx)).toBeUndefined();
  });

  /** A context that throws on every read, as Pi's does once its session is replaced. */
  const stale = (ctx: object) => {
    for (const key of ["hasUI", "ui", "cwd", "sessionManager"])
      Object.defineProperty(ctx, key, {
        get() {
          throw new Error("This extension ctx is stale after session replacement or reload.");
        },
      });
  };

  it.each([
    ["after a shutdown event", true],
    ["when the ctx goes stale without one", false],
  ])("drops a failure that arrives %s", async (_name, shutdown) => {
    const first = await start();
    await first.tool("git_worktree_create", { repo: "src/api", branch: "slow" });
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      // The refresh awaits git for the worktree, then reads the config, which fails.
      const h = harness({
        sessionId: "parent",
        cwd: box.dir,
        root: box.root,
        entries: first.entries,
        loadConfig: () => {
          throw new Error("config unreadable");
        },
      });
      // Every start handler has run by now; the refresh it began is still waiting for git.
      await h.fire("session_start");
      if (shutdown) await h.fire("session_shutdown");
      stale(h.ctx);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(rejections).toEqual([]);
      expect(h.ui.notify).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("still reports a failure to a live session", async () => {
    const first = await start();
    await first.tool("git_worktree_create", { repo: "src/api", branch: "slow" });
    const h = harness({
      sessionId: "parent",
      cwd: box.dir,
      root: box.root,
      entries: first.entries,
      loadConfig: () => {
        throw new Error("config unreadable");
      },
    });
    await h.fire("session_start");
    await vi.waitFor(() =>
      expect(h.ui.notify).toHaveBeenCalledWith(
        "pi-git: could not check worktrees: config unreadable",
        "warning",
      ),
    );
  });
});

describe("git_worktree_remove", () => {
  it("refuses uncommitted work, removes with force, and keeps the record as removed", async () => {
    const h = await start();
    await h.tool("git_worktree_create", { repo: "src/api", branch: "wip" });
    const path = join(box.root, "api", "wip");
    commit(path, "a.txt", "a");
    writeFileSync(join(path, "b.txt"), "b");
    await expect(h.tool("git_worktree_remove", { path })).rejects.toThrow(
      /has uncommitted changes, which removing it would lose; commit it to a branch, or pass force/,
    );
    const removed = await h.tool("git_worktree_remove", { path, force: true });
    expect(removed.content[0].text).toBe(
      `Removed worktree ${path}; branch wip is kept in ${box.api}. It holds 1 commit that no remote has.`,
    );
    expect(h.ledger().at(-1)?.state).toBe("removed");
    expect((await h.tool("git_worktree_list", {})).content[0].text).toBe(
      "No worktrees in this session's ledger.\n(1 removed worktree not shown)",
    );
    expect((await h.tool("git_worktree_list", { includeRemoved: true })).content[0].text).toContain(
      `- ${path}\n  api @ wip — removed`,
    );
  });

  it("removes a worktree another session created under the root, relative to the cwd", async () => {
    const other = await start("other");
    await other.tool("git_worktree_create", { repo: "src/web", branch: "theirs" });
    const h = await start("parent");
    const list = await h.tool("git_worktree_list", {});
    expect(list.content[0].text).toContain(
      "Under the worktree root but not in this session's ledger:",
    );
    await h.tool("git_worktree_remove", { path: "worktrees/web/theirs" });
    expect(h.ledger().at(-1)).toMatchObject({
      path: join(box.root, "web", "theirs"),
      state: "removed",
    });
  });

  it("finds and removes a worktree another session recreated at a path this one removed", async () => {
    const a = await start("session-a");
    await a.tool("git_worktree_create", { repo: "src/api", branch: "reuse" });
    const path = join(box.root, "api", "reuse");
    await a.tool("git_worktree_remove", { path });
    const b = await start("session-b");
    await b.tool("git_worktree_create", { repo: "src/api", branch: "reuse" });

    const list = await a.tool("git_worktree_list", {});
    expect(list.content[0].text).toContain(
      `Under the worktree root but not in this session's ledger:\n- ${path} — api @ reuse`,
    );
    await a.tool("git_worktree_remove", { path });
    expect(existsSync(path)).toBe(false);
    await expect(a.tool("git_worktree_remove", { path })).rejects.toThrow(/was already removed/);
  });

  it("refuses a path that is neither in the ledger nor under the root", async () => {
    const h = await start();
    await expect(h.tool("git_worktree_remove", { path: box.api })).rejects.toThrow(
      /is not a worktree in this session's ledger or under/,
    );
  });
});

describe("subagents", () => {
  it("hands a worktree a subagent creates up to its parent's ledger", async () => {
    const parent = await start("parent");
    // pi-subagent announces the child on the parent's bus before the child starts.
    parent.pi.events.emit("subagent:session:created", {
      sessionId: "child",
      parentSessionId: "parent",
      agentId: "agent-7",
      cwd: box.dir,
    });
    const child = await start("child");
    await child.tool("git_worktree_create", { repo: "src/api", branch: "child-work" });

    const adopted = parent.ledger();
    expect(adopted).toEqual([
      expect.objectContaining({
        path: join(box.root, "api", "child-work"),
        createdBy: "agent-7",
        via: "adopt",
      }),
    ]);
    // A newer change in the child replaces it; a repeat adds nothing.
    await child.tool("git_worktree_remove", { path: join(box.root, "api", "child-work") });
    expect(parent.ledger().at(-1)?.state).toBe("removed");
    expect(parent.ledger()).toHaveLength(2);
  });

  it("keeps the agents the parent recorded when it adopts a child's later change", async () => {
    const parent = await start("parent");
    parent.pi.events.emit("subagent:session:created", {
      sessionId: "child",
      parentSessionId: "parent",
      agentId: "agent-7",
      cwd: box.dir,
    });
    const child = await start("child");
    await child.tool("git_worktree_create", { repo: "src/api", branch: "shared" });
    const path = join(box.root, "api", "shared");
    // The parent starts another worker in the child's worktree.
    parent.pi.events.emit("subagent:session:created", {
      sessionId: "worker",
      agentId: "agent-9",
      cwd: path,
    });
    expect(parent.ledger().at(-1)?.agents).toEqual(["agent-9"]);

    await child.tool("git_worktree_remove", { path });
    expect(parent.ledger().at(-1)).toMatchObject({ state: "removed", agents: ["agent-9"] });
  });

  it("merges a child's new agent even when the parent's record is newer", async () => {
    const parent = await start("parent");
    parent.pi.events.emit("subagent:session:created", {
      sessionId: "child",
      parentSessionId: "parent",
      agentId: "agent-7",
      cwd: box.dir,
    });
    const child = await start("child");
    await child.tool("git_worktree_create", { repo: "src/api", branch: "race" });
    const path = join(box.root, "api", "race");

    // One millisecond: the parent records two workers, which pushes its
    // record's time ahead of the child's, then the child records its own.
    frozen = true;
    for (const agentId of ["agent-a", "agent-b"])
      parent.pi.events.emit("subagent:session:created", { sessionId: agentId, agentId, cwd: path });
    child.pi.events.emit("subagent:session:created", {
      sessionId: "agent-c",
      agentId: "agent-c",
      cwd: path,
    });
    frozen = false;

    expect(child.ledger().at(-1)?.agents).toEqual(["agent-c"]);
    expect(parent.ledger().at(-1)?.agents).toEqual(["agent-a", "agent-b", "agent-c"]);
  });

  it("adopts a change made in the same millisecond as its own, but not a repeat", async () => {
    const parent = await start("parent");
    parent.pi.events.emit("subagent:session:created", {
      sessionId: "child",
      parentSessionId: "parent",
      agentId: "agent-7",
      cwd: box.dir,
    });
    const child = await start("child");
    await child.tool("git_worktree_create", { repo: "src/api", branch: "tie" });
    const adopted = parent.ledger().at(-1)!;
    const service = (await import("#session-tree")).service<{
      adopt(record: unknown): boolean;
    }>("parent", "pi-git")!;

    expect(service.adopt({ ...adopted, via: undefined })).toBe(false);
    expect(service.adopt({ ...adopted, state: "missing" })).toBe(true);
    expect(service.adopt({ ...adopted, updatedAt: adopted.updatedAt - 1, state: "removed" })).toBe(
      false,
    );
    expect(parent.ledger().at(-1)?.state).toBe("missing");
  });
});

describe("/git:worktrees", () => {
  it("lists as text outside the interactive terminal", async () => {
    const h = await start();
    await h.tool("git_worktree_create", { repo: "src/api", branch: "feat/x" });
    await h.commands.get("git:worktrees")!.handler("", h.ctx);
    expect(h.ui.notify).toHaveBeenCalledWith(
      `- ${join(box.root, "api", "feat-x")}\n  api @ feat/x — clean`,
      "info",
    );
  });

  it("removes a picked worktree after confirmation, warning about unsaved work", async () => {
    const h = await start();
    await h.tool("git_worktree_create", { repo: "src/api", branch: "wip" });
    const path = join(box.root, "api", "wip");
    writeFileSync(join(path, "x.txt"), "x");
    await h.commands.get("git:worktrees")!.handler("remove", h.ctx);
    expect(h.ui.confirm).toHaveBeenCalledWith(
      "Remove worktree?",
      `${path} has uncommitted changes. Removing it discards that work; branch wip is kept.`,
    );
    expect(h.ledger().at(-1)?.state).toBe("removed");
  });

  it("keeps the worktree when removal is not confirmed", async () => {
    const h = await start();
    await h.tool("git_worktree_create", { repo: "src/api", branch: "keep" });
    h.ui.confirm.mockResolvedValueOnce(false);
    await h.commands.get("git:worktrees")!.handler("remove", h.ctx);
    expect(h.ledger().at(-1)?.state).toBe("active");
  });
});

describe("pull requests", () => {
  const ghResult = (command: string, output: string, toolCallId = `call-${Math.random()}`) => ({
    type: "tool_result",
    toolName: "bash",
    toolCallId,
    input: { command },
    content: [{ type: "text", text: output }],
    isError: false,
  });
  const prs = (h: Awaited<ReturnType<typeof start>>) =>
    h.entries
      .filter((entry) => (entry as { data?: { kind?: string } }).data?.kind === "pr")
      .map((entry) => (entry as { data: Record<string, unknown> }).data);

  it("records a PR opened here, then what later checks showed, keeping both", async () => {
    const h = await start();
    await h.fire(
      "tool_result",
      ghResult("gh pr create --fill", "https://github.com/acme/api/pull/12", "c1"),
    );
    await h.fire(
      "tool_result",
      ghResult(
        "gh pr view 12 -R acme/api --json url,reviewDecision",
        '{"url":"https://github.com/acme/api/pull/12","reviewDecision":"APPROVED"}',
        "c2",
      ),
    );
    const latest = prs(h).at(-1)!;
    expect(latest).toMatchObject({
      kind: "pr",
      key: "github.com/acme/api#12",
      origin: "created",
      status: { state: "open", review: "approved", source: "bash" },
      calls: [
        { tool: "bash", toolCallId: "c1" },
        { tool: "bash", toolCallId: "c2" },
      ],
    });
    expect(h.snapshots.at(-1)?.prs.map((pr) => pr.key)).toEqual(["github.com/acme/api#12"]);
  });

  it("upgrades a referenced PR to opened here when this session is seen opening it", async () => {
    const h = await start();
    await h.fire("tool_result", {
      type: "tool_result",
      toolName: "WebFetch",
      toolCallId: "w1",
      input: { url: "https://github.com/acme/api/pull/3" },
      content: [],
      isError: false,
    });
    expect(prs(h).at(-1)?.origin).toBe("referenced");
    await h.fire("tool_result", ghResult("gh pr create", "https://github.com/acme/api/pull/3"));
    expect(prs(h).at(-1)?.origin).toBe("created");
  });

  it("skips PRs only looked at when trackReferenced is off", async () => {
    const h = harness({ sessionId: "s", cwd: box.dir, root: box.root, trackReferenced: false });
    await h.fire("session_start");
    await h.fire("tool_result", ghResult("gh pr view https://github.com/acme/api/pull/4", ""));
    expect(prs(h)).toEqual([]);
    await h.fire("tool_result", ghResult("gh pr create", "https://github.com/acme/api/pull/5"));
    expect(prs(h).map((pr) => pr.key)).toEqual(["github.com/acme/api#5"]);
  });

  it("restores PRs after a reload and lists them in two groups", async () => {
    const first = await start();
    await first.fire(
      "tool_result",
      ghResult("gh pr create --title 'Add login'", "https://github.com/acme/api/pull/12"),
    );
    await first.fire(
      "tool_result",
      ghResult(
        "gh pr view https://github.com/acme/web/pull/7",
        "title:\tFix nav\nstate:\tMERGED\n",
      ),
    );
    const reloaded = await start("parent", first.entries);
    const list = await reloaded.tool("git_pr_list", {});
    expect(list.content[0].text).toMatch(
      /^Opened here:\n- acme\/api#12\n {2}open \(seen \d+s ago via bash\)\n {2}https:\/\/github.com\/acme\/api\/pull\/12\n\nReferenced:\n- acme\/web#7 — Fix nav\n {2}merged \(seen \d+s ago via bash\)\n {2}https:\/\/github.com\/acme\/web\/pull\/7$/,
    );
    const opened = await reloaded.tool("git_pr_list", { includeReferenced: false });
    expect(opened.content[0].text).not.toContain("Referenced");
    await reloaded.commands.get("git:prs")!.handler("", reloaded.ctx);
    expect(reloaded.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("- acme/api#12"),
      "info",
    );
  });

  it("hands a PR a subagent opened up to its parent, with the subagent's id", async () => {
    const parent = await start("parent");
    parent.pi.events.emit("subagent:session:created", {
      sessionId: "child",
      parentSessionId: "parent",
      agentId: "agent-7",
      cwd: box.dir,
    });
    const child = await start("child");
    await child.fire(
      "tool_result",
      ghResult("gh pr create", "https://github.com/acme/api/pull/20", "k1"),
    );
    await parent.fire(
      "tool_result",
      ghResult("gh pr checks 20 -R acme/api", "ci\tpass\t1s\thttps://x\t", "p1"),
    );
    await child.fire("tool_result", ghResult("gh pr view 20 -R acme/api", "state:\tMERGED", "k2"));

    expect(prs(parent).at(-1)).toMatchObject({
      origin: "created",
      createdBy: "agent-7",
      via: "adopt",
      status: { state: "merged", checks: { passed: 1, failed: 0, pending: 0 } },
      calls: [
        { toolCallId: "k1", agentId: "agent-7" },
        { toolCallId: "p1" },
        { toolCallId: "k2", agentId: "agent-7" },
      ],
    });
  });

  it("does not let a subagent's later checks read reopen a PR its parent saw merged", async () => {
    const parent = await start("parent");
    parent.pi.events.emit("subagent:session:created", {
      sessionId: "child",
      parentSessionId: "parent",
      agentId: "agent-7",
      cwd: box.dir,
    });
    const child = await start("child");
    await child.fire("tool_result", ghResult("gh pr view 20 -R acme/api", "state:\tOPEN", "k1"));
    await parent.fire("tool_result", ghResult("gh pr view 20 -R acme/api", "state:\tMERGED", "p1"));
    await child.fire(
      "tool_result",
      ghResult("gh pr checks 20 -R acme/api", "ci\tpass\t1s\thttps://x\t", "k2"),
    );
    expect(prs(parent).at(-1)).toMatchObject({
      status: { state: "merged", checks: { passed: 1, failed: 0, pending: 0 } },
    });
  });

  it("never fails a tool result it cannot read", async () => {
    const h = await start();
    await expect(h.fire("tool_result", { toolName: "bash", input: null })).resolves.toBeUndefined();
    expect(prs(h)).toEqual([]);
  });

  it("persists ordinary tool calls even when they do not change PR status", async () => {
    const h = await start();
    await h.fire(
      "tool_result",
      ghResult("gh pr create", "https://github.com/acme/api/pull/12", "create"),
    );
    await h.fire(
      "tool_result",
      ghResult("gh pr comment 12 -R acme/api --body 'Reviewed'", "", "comment"),
    );
    const reloaded = await start("parent", h.entries);
    expect(reloaded.snapshots.at(-1)?.prs[0].calls.map((call) => call.toolCallId)).toEqual([
      "create",
      "comment",
    ]);
  });
});

describe("git_pr_status and /git:refresh", () => {
  const view = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      number: 12,
      url: "https://github.com/acme/api/pull/12",
      title: "Add login",
      state: "OPEN",
      isDraft: false,
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "MERGEABLE",
      headRefName: "feat/login",
      headRefOid: "abc123",
      statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" }],
      ...overrides,
    });
  const prEntries = (h: Awaited<ReturnType<typeof start>>) =>
    h.entries
      .filter((entry) => (entry as { data?: { kind?: string } }).data?.kind === "pr")
      .map((entry) => (entry as { data: Record<string, unknown> }).data);
  const withGh = async (runGh: GhRunner, entries?: unknown[]) => {
    const h = harness({ sessionId: "parent", cwd: box.dir, root: box.root, runGh, entries });
    await h.fire("session_start");
    return h;
  };

  it("reads a PR through gh, records it, and returns structured status", async () => {
    const runGh = vi.fn(async () => view());
    const h = await withGh(runGh);
    const result = (await h.tool("git_pr_status", { pr: "acme/api#12" })) as unknown as {
      content: { text: string }[];
      structuredContent: { prs: Record<string, unknown>[] };
    };
    expect(result.structuredContent.prs).toEqual([
      {
        key: "github.com/acme/api#12",
        label: "acme/api#12",
        url: "https://github.com/acme/api/pull/12",
        title: "Add login",
        state: "open",
        draft: false,
        review: "review_required",
        mergeable: true,
        headRef: "feat/login",
        headSha: "abc123",
        checks: { passed: 0, failed: 0, pending: 1 },
        ciDone: false,
        source: "gh",
      },
    ]);
    expect(result.content[0].text).toBe(
      [
        "- acme/api#12 — Add login",
        "  open · review required · checks 1 pending · head abc123 (via gh)",
        "  https://github.com/acme/api/pull/12",
      ].join("\n"),
    );
    expect(prEntries(h).at(-1)).toMatchObject({
      origin: "referenced",
      status: { state: "open", source: "gh" },
      calls: [{ tool: "git_pr_status", toolCallId: "call-1" }],
    });
  });

  it("without pr, reads every open PR opened here, and none that is merged or only referenced", async () => {
    const runGh = vi.fn(async (args: readonly string[]) =>
      view({ number: Number(/pull\/(\d+)/.exec(args[2])?.[1]), url: args[2] }),
    );
    const h = await withGh(runGh);
    const created = (n: number, state?: string) =>
      h
        .fire("tool_result", {
          toolName: "bash",
          toolCallId: `c${n}`,
          input: { command: "gh pr create --fill" },
          content: [{ type: "text", text: `https://github.com/acme/api/pull/${n}` }],
          isError: false,
        })
        .then(() =>
          state
            ? h.fire("tool_result", {
                toolName: "bash",
                toolCallId: `m${n}`,
                input: { command: `gh pr view ${n} -R acme/api` },
                content: [{ type: "text", text: `state:\t${state}` }],
                isError: false,
              })
            : undefined,
        );
    await created(1);
    await created(2, "MERGED");
    await h.fire("tool_result", {
      toolName: "WebFetch",
      toolCallId: "w3",
      input: { url: "https://github.com/acme/api/pull/3" },
      content: [],
      isError: false,
    });
    await h.tool("git_pr_status", {});
    expect(runGh.mock.calls.map((call) => call[0][2])).toEqual([
      "https://github.com/acme/api/pull/1",
    ]);
    runGh.mockClear();
    await h.tool("git_pr_status", { includeReferenced: true });
    expect(runGh.mock.calls.map((call) => call[0][2]).sort()).toEqual([
      "https://github.com/acme/api/pull/1",
      "https://github.com/acme/api/pull/3",
    ]);
  });

  it("says when there is nothing to read", async () => {
    const h = await withGh(vi.fn());
    const result = await h.tool("git_pr_status", {});
    expect(result.content[0].text).toBe(
      "No open pull requests in this session's ledger. Pass pr to read one.",
    );
  });

  it("falls back to the GitHub MCP reader when gh cannot answer, recording each read once", async () => {
    const h = await withGh(async () => {
      throw new GhUnavailable("gh is not installed");
    });
    const executeTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      // Pi fires tool_result for the nested call, with the caller as parent.
      const content = [
        {
          type: "text",
          text:
            args.method === "get"
              ? JSON.stringify({
                  number: 12,
                  html_url: "https://github.com/acme/api/pull/12",
                  state: "closed",
                  merged: true,
                })
              : args.method === "get_check_runs"
                ? JSON.stringify({ total_count: 0, check_runs: [] })
                : args.method === "get_status"
                  ? JSON.stringify({ total_count: 0, statuses: [] })
                  : "[]",
        },
      ];
      await h.fire("tool_result", {
        toolName: name,
        toolCallId: `call-1/${String(args.method)}`,
        parentToolCallId: "call-1",
        input: args,
        content,
        isError: false,
      });
      return { isError: false, result: { content } };
    });
    Object.assign(h.ctx, { executeTool, tools: [{ name: "mcp__github__pull_request_read" }] });
    const result = (await h.tool("git_pr_status", {
      pr: "https://github.com/acme/api/pull/12",
    })) as unknown as { structuredContent: { prs: Record<string, unknown>[] } };
    expect(result.structuredContent.prs[0]).toMatchObject({
      state: "merged",
      review: "none",
      source: "mcp__github__pull_request_read",
    });
    expect(executeTool.mock.calls.map((call) => call[1].method)).toEqual([
      "get",
      "get_check_runs",
      "get_status",
      "get_reviews",
      "get",
    ]);
    const recorded = prEntries(h);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ calls: [{ tool: "git_pr_status" }] });
  });

  it("fails when gh cannot answer and no MCP reader is reachable", async () => {
    const h = await withGh(async () => {
      throw new GhUnavailable("gh is not signed in");
    });
    await expect(h.tool("git_pr_status", { pr: "acme/api#12" })).rejects.toThrow(
      "acme/api#12: gh is not signed in, and no GitHub MCP pull_request_read tool is available to read it instead",
    );
  });

  it("does not write another ledger entry when a watch reads the same status again", async () => {
    const h = await withGh(async () => view());
    await h.tool("git_pr_status", { pr: "acme/api#12" });
    const first = h.snapshots.at(-1)!.prs[0].status!.observedAt;
    await h.tool("git_pr_status", { pr: "acme/api#12" });
    expect(prEntries(h)).toHaveLength(1);
    // The in-memory record still moves on: the snapshot shows the newer read.
    expect(h.snapshots.at(-1)!.prs[0].status!.observedAt).toBeGreaterThan(first);
  });

  it("hands unchanged polling observations up without growing either session's ledger", async () => {
    const parent = await withGh(async () => view({ state: "CLOSED" }));
    parent.pi.events.emit("subagent:session:created", {
      sessionId: "child",
      parentSessionId: "parent",
      agentId: "agent-7",
      cwd: box.dir,
    });
    const child = harness({
      sessionId: "child",
      cwd: box.dir,
      root: box.root,
      runGh: async () => view(),
    });
    await child.fire("session_start");
    await child.tool("git_pr_status", { pr: "acme/api#12" });
    const first = parent.snapshots.at(-1)!.prs[0].status!.observedAt;
    await child.tool("git_pr_status", { pr: "acme/api#12" });
    expect(prEntries(child)).toHaveLength(1);
    expect(prEntries(parent)).toHaveLength(1);
    expect(parent.snapshots.at(-1)!.prs[0].status!.observedAt).toBeGreaterThan(first);

    // A read unchanged from the child's point of view can still correct a
    // different observation in its parent, and that change must persist.
    await parent.tool("git_pr_status", { pr: "acme/api#12" });
    expect(parent.snapshots.at(-1)!.prs[0].status!.state).toBe("closed");
    await child.tool("git_pr_status", { pr: "acme/api#12" });
    expect(prEntries(child)).toHaveLength(1);
    const reloaded = await start("parent", parent.entries);
    expect(reloaded.snapshots.at(-1)!.prs[0].status!.state).toBe("open");
  });

  it("clears old green counts when a new head has no checks yet", async () => {
    let pushed = false;
    const h = await withGh(async () =>
      view({
        headRefOid: pushed ? "new-head" : "old-head",
        statusCheckRollup: pushed ? [] : [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
    );
    await h.tool("git_pr_status", { pr: "acme/api#12" });
    pushed = true;
    const result = await h.tool("git_pr_status", { pr: "acme/api#12" });
    expect(result.details).toMatchObject({ prs: [{ headSha: "new-head", ciDone: false }] });
    const reloaded = await start("parent", h.entries);
    expect(reloaded.snapshots.at(-1)?.prs[0].status).toMatchObject({
      headSha: "new-head",
      checks: { passed: 0, failed: 0, pending: 0 },
    });
  });

  it("does not record a cancelled read even if the backend returns successfully", async () => {
    const controller = new AbortController();
    const h = await withGh(async () => {
      controller.abort(new Error("cancelled"));
      return view();
    });
    await expect(
      h.tools
        .get("git_pr_status")!
        .execute("cancel", { pr: "acme/api#12" }, controller.signal, undefined, h.ctx),
    ).rejects.toThrow("cancelled");
    expect(prEntries(h)).toEqual([]);
  });

  it("discards a response from the session that shut down while the read was in flight", async () => {
    let answer!: (text: string) => void;
    const h = await withGh(
      () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    );
    const reading = h.tool("git_pr_status", { pr: "acme/api#12" });
    await h.fire("session_shutdown");
    answer(view());
    await expect(reading).rejects.toThrow("session changed");
    expect(prEntries(h)).toEqual([]);
  });

  it("ignores its own result in the observer", async () => {
    const h = await withGh(async () => view());
    await h.fire("tool_result", {
      toolName: "git_pr_status",
      toolCallId: "x",
      input: { pr: "https://github.com/acme/api/pull/99" },
      content: [],
      isError: false,
    });
    expect(prEntries(h)).toEqual([]);
  });

  it("/git:refresh re-reads open PRs through gh and reports what it could not read", async () => {
    let fail = false;
    const runGh = vi.fn(async () => {
      if (fail) throw new GhUnavailable("gh is not installed");
      return view({
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      });
    });
    const h = await withGh(runGh);
    await h.fire("tool_result", {
      toolName: "bash",
      toolCallId: "c1",
      input: { command: "gh pr create" },
      content: [{ type: "text", text: "https://github.com/acme/api/pull/12" }],
      isError: false,
    });
    await h.commands.get("git:refresh")!.handler("", h.ctx);
    expect(h.ui.notify).toHaveBeenLastCalledWith(
      "Refreshed 1 of 1 open pull request; worktrees checked.",
      "info",
    );
    expect(prEntries(h).at(-1)).toMatchObject({
      status: { checks: { passed: 1, failed: 0, pending: 0 } },
      calls: [{ toolCallId: "c1" }, { tool: "/git:refresh" }],
    });
    fail = true;
    await h.commands.get("git:refresh")!.handler("", h.ctx);
    expect(h.ui.notify).toHaveBeenLastCalledWith(
      [
        "Refreshed 0 of 1 open pull request; worktrees checked.",
        "acme/api#12: gh is not installed, and no GitHub MCP pull_request_read tool is available to read it instead",
        "Without gh, ask the agent to run git_pr_status, which can read through the GitHub MCP tools.",
      ].join("\n"),
      "warning",
    );
  });
});

describe("git_pr_watch", () => {
  const URL = "https://github.com/acme/api/pull/12";
  const KEY = "github.com/acme/api#12";
  const run = (status: string, conclusion = "", name = "unit") => ({
    __typename: "CheckRun",
    name,
    status,
    conclusion,
  });
  const view = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      number: 12,
      url: URL,
      title: "Add login",
      state: "OPEN",
      isDraft: false,
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "MERGEABLE",
      headRefName: "feat/login",
      headRefOid: "abc123",
      statusCheckRollup: [run("IN_PROGRESS")],
      comments: [],
      reviews: [],
      ...overrides,
    });
  const failed = {
    statusCheckRollup: [run("COMPLETED", "FAILURE", "lint"), run("COMPLETED", "SUCCESS")],
  };
  type Result = { content: { text: string }[]; details: { watching: boolean; watch?: unknown } };
  const watching = async (
    runGh: GhRunner,
    options: { entries?: unknown[]; trackReferenced?: boolean } = {},
  ) => {
    const h = harness({ sessionId: "parent", cwd: box.dir, root: box.root, runGh, ...options });
    await h.fire("session_start");
    // Only the watch's timer is faked: git and the worktree refresh run for real.
    // A second session of the same test keeps the clock its adopted watch already waits on.
    if (!vi.isFakeTimers()) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      onTestFinished(() => void vi.useRealTimers());
    }
    const watch = (params: Record<string, unknown> = {}) =>
      h.tool("git_pr_watch", { pr: "acme/api#12", ...params }) as unknown as Promise<Result>;
    /** The work messages the session's host sent, as text. */
    const messages = () =>
      h.pi.sendMessage.mock.calls.map(([message]) => (message as { content: string }).content);
    const watched = () => h.snapshots.at(-1)!.prs.find((pr) => pr.key === KEY)?.watch;
    return { ...h, watch, messages, watched };
  };
  const interval = () => vi.advanceTimersByTimeAsync(60_000);

  it("watches a PR, shows it as watched, and wakes the session when checks finish", async () => {
    let reply = view();
    const h = await watching(vi.fn(async () => reply));
    const result = await h.watch();
    expect(result.content[0].text).toBe(
      [
        "Now watching until checks finish on its head (120m left). End your turn: a message wakes you when checks finish, the head moves, a review or comment arrives, or it is merged or closed.",
        "- acme/api#12 — Add login",
        "  open · review required · checks 1 pending · head abc123 (via gh)",
        `  ${URL}`,
      ].join("\n"),
    );
    expect(result.details).toMatchObject({ watching: true, watch: { key: KEY, until: "settled" } });
    expect(h.watched()).toMatchObject({ until: "settled" });
    const listed = await h.tool("git_pr_list", {});
    expect(listed.content[0].text).toContain(
      "  watching until checks finish on its head (120m left)",
    );
    // The watch's item is persisted as open work.
    expect(h.entries).toContainEqual(
      expect.objectContaining({
        customType: "work:item",
        data: expect.objectContaining({
          op: "open",
          owner: "pi-git",
          kind: "pr",
          label: "PR 12 CI",
        }),
      }),
    );

    await interval();
    expect(h.messages()).toEqual([]);
    reply = view(failed);
    await interval();
    expect(h.messages()).toEqual([
      [
        "Pull request acme/api#12:",
        "Checks finished on head abc123: 1 failed (lint), 1 passed.",
        "The watch has ended.",
        URL,
      ].join("\n"),
    ]);
    expect(h.pi.sendMessage.mock.calls[0]).toMatchObject([
      { customType: "git:pr-watch" },
      { triggerTurn: true },
    ]);
    expect(h.watched()).toBeUndefined();
    // Each read went into the ledger, and an unchanged one wrote no entry.
    const records = h.ledger().filter((record) => (record as { kind: string }).kind === "pr");
    expect(records).toHaveLength(2);
    expect(records.at(-1)).toMatchObject({
      status: { checks: { passed: 1, failed: 1, pending: 0 } },
      calls: [{ tool: "git_pr_watch", toolCallId: "call-1" }],
    });
  });

  it("returns the existing watch for a second call and continues from what it read", async () => {
    let reply = view();
    const runGh = vi.fn(async () => reply);
    const h = await watching(runGh);
    await h.watch();
    // The agent pushed, then called again: its own push is not reported back.
    reply = view({ headRefOid: "def456" });
    const again = await h.watch();
    expect(again.content[0].text).toMatch(
      /^Already watching until checks finish on its head \(\d+m left\); it continues from this status\./,
    );
    expect(again.content[0].text).toContain("head def456");
    expect(
      h.entries.filter((entry) => (entry as { customType?: string }).customType === "work:item"),
    ).toHaveLength(1);
    await interval();
    expect(h.messages()).toEqual([]);
    reply = view({ headRefOid: "def456", statusCheckRollup: [run("COMPLETED", "SUCCESS")] });
    await interval();
    expect(h.messages()[0]).toContain("Checks finished on head def456: all 1 passed.");
  });

  it("replaces the watch when until changes", async () => {
    const h = await watching(async () => view());
    await h.watch();
    const result = await h.watch({ until: "merged", timeoutSeconds: 600 });
    expect(result.content[0].text).toMatch(
      /^Now watching until it is merged or closed \(10m left\)/,
    );
    expect(h.watched()).toMatchObject({ until: "merged" });
  });

  it("does not watch what has nothing left to wait for", async () => {
    let reply = view(failed);
    const h = await watching(async () => reply);
    const settled = await h.watch();
    expect(settled.content[0].text).toMatch(
      /^Not watching acme\/api#12: checks already finished on head abc123\. If that is not the commit you pushed/,
    );
    expect(settled.details.watching).toBe(false);
    expect(h.watched()).toBeUndefined();
    // Reviews and the merge can still be waited for.
    const open = await h.watch({ until: "merged" });
    expect(open.details.watching).toBe(true);
    reply = view({ state: "MERGED" });
    const merged = await h.watch({ until: "merged" });
    expect(merged.content[0].text).toMatch(/^Not watching acme\/api#12: it is merged\.\n/);
    expect(h.watched()).toBeUndefined();
    expect(h.messages()).toEqual([]);
  });

  it("stops on request", async () => {
    const runGh = vi.fn(async () => view());
    const h = await watching(runGh);
    await h.watch();
    expect((await h.watch({ stop: true })).content[0].text).toBe("Stopped watching acme/api#12.");
    expect((await h.watch({ stop: true })).content[0].text).toBe(
      "acme/api#12 was not being watched.",
    );
    expect(h.watched()).toBeUndefined();
    await interval();
    expect(runGh).toHaveBeenCalledTimes(1);
  });

  it("caps the watches of one session", async () => {
    const h = await watching(async () => view());
    for (let number = 1; number <= 10; number++) await h.watch({ pr: `acme/api#${number}` });
    await expect(h.watch({ pr: "acme/api#11" })).rejects.toThrow(
      "git_pr_watch: 10 pull requests are already watched",
    );
    // One that is already watched is not a new watch.
    expect((await h.watch({ pr: "acme/api#3" })).details.watching).toBe(true);
  });

  it("fails without starting a watch when the PR cannot be read", async () => {
    const h = await watching(async () => {
      throw new Error("HTTP 404: Not Found");
    });
    await expect(h.watch()).rejects.toThrow("git_pr_watch: HTTP 404: Not Found");
    await expect(h.watch({ pr: "feat/login" })).rejects.toThrow("is not a pull request URL");
    expect(h.snapshots.at(-1)!.prs).toEqual([]);
  });

  it("records a watched PR even when referenced PRs are not tracked", async () => {
    const h = await watching(async () => view(), { trackReferenced: false });
    await h.watch();
    expect(h.watched()).toBeDefined();
  });

  it("adopts its watch after a reload and continues from the saved baseline", async () => {
    let reply = view();
    const first = await watching(async () => reply);
    await first.watch({ until: "merged" });
    reply = view({
      reviewDecision: "CHANGES_REQUESTED",
      reviews: [{ state: "CHANGES_REQUESTED" }],
    });
    await interval();
    expect(first.messages()).toEqual([
      [
        "Pull request acme/api#12:",
        "Review decision is now changes requested (was review required).",
        "1 new review since the last report. A reply in a review thread counts as a review, and your own are counted.",
        "Still watching until it is merged or closed.",
        URL,
      ].join("\n"),
    ]);
    await first.fire("session_shutdown");
    await interval();
    expect(first.messages()).toHaveLength(1);

    const second = await watching(async () => reply, { entries: first.entries });
    expect(second.watched()).toMatchObject({ until: "merged" });
    await second.fire("resources_discover");
    // Nothing was lost, and what was already reported is not reported again.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(second.messages()).toEqual([]);
    reply = view({ state: "MERGED" });
    await interval();
    expect(second.messages()).toEqual([
      ["Pull request acme/api#12:", "Merged.", "The watch has ended.", URL].join("\n"),
    ]);
  });

  it("reads through the GitHub MCP tool of the call that started it when gh is unavailable", async () => {
    const h = await watching(async () => {
      throw new GhUnavailable("gh is not installed");
    });
    let conclusion: string | null = null;
    const executeTool = vi.fn(async (_name: string, args: { method: string }) => {
      const body: Record<string, unknown> = {
        get: {
          number: 12,
          html_url: URL,
          title: "Add login",
          state: "open",
          draft: false,
          comments: 0,
          head: { ref: "feat/login", sha: "abc123" },
        },
        get_check_runs: {
          total_count: 1,
          check_runs: [
            { name: "unit", status: conclusion ? "completed" : "in_progress", conclusion },
          ],
        },
        get_status: { sha: "abc123", total_count: 0, statuses: [] },
        get_reviews: [],
      };
      return {
        isError: false,
        result: { content: [{ type: "text", text: JSON.stringify(body[args.method]) }] },
      };
    });
    const ctx = { ...h.ctx, executeTool, tools: [{ name: "mcp__github__pull_request_read" }] };
    const result = (await h.pi.registerTool.mock.calls
      .map(([tool]) => tool)
      .find((tool) => tool.name === "git_pr_watch")!
      .execute("call-7", { pr: "acme/api#12" }, undefined, undefined, ctx)) as Result;
    expect(result.content[0].text).toContain("(via mcp__github__pull_request_read)");
    // The watch's nested reads are its own: the observer does not record them a second time.
    const before = h.ledger().length;
    await h.fire("tool_result", {
      toolName: "mcp__github__pull_request_read",
      toolCallId: "call-7/9",
      parentToolCallId: "call-7",
      input: { method: "get", owner: "acme", repo: "api", pullNumber: 12 },
      content: [{ type: "text", text: "{}" }],
      isError: false,
    });
    expect(h.ledger()).toHaveLength(before);

    conclusion = "failure";
    await interval();
    expect(h.messages()[0]).toContain("Checks finished on head abc123: 1 failed (unit).");
  });

  it("ends an adopted watch that can only be read through MCP, which a reload took away", async () => {
    let available = true;
    const runGh: GhRunner = async () => {
      if (!available) throw new GhUnavailable("gh is not signed in");
      return view();
    };
    const first = await watching(runGh);
    await first.watch();
    await first.fire("session_shutdown");
    available = false;
    const second = await watching(runGh, { entries: first.entries });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(second.messages()).toEqual([
      [
        "Pull request acme/api#12:",
        "Its status can no longer be read: gh is not signed in, and no GitHub MCP pull_request_read tool is available to read it instead",
        "Call git_pr_watch again once it can be read.",
        "The watch has ended.",
        URL,
      ].join("\n"),
    ]);
  });
});
