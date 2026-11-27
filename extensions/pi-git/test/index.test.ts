import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { fakePi, resetSessionTree } from "#test-helpers";
import type { GitConfig } from "#src/config";
import { GIT_PRS_VIEW, GIT_SUMMARY_VIEW, GIT_WORKTREES_VIEW } from "#src/events";
import {
  ATTENTION_TYPE,
  GIT_ATTENTION_DISMISS,
  GIT_ATTENTION_VIEW,
  type AttentionEntry,
} from "#src/attention";
import type { GitSnapshot } from "#src/snapshot";
import {
  collectDelivery,
  dispatchAction,
  isViewModel,
  listActions,
  listViews,
  settleSnapshot,
  type AttentionModel,
  onViewChanged,
  readView,
  summaryCount,
  type ExplorerModel,
  type SummaryModel,
} from "#surface";
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
  const snapshots: GitSnapshot[] = [];
  const fake = fakePi({
    appendEntry: vi.fn((customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
    ),
  });
  piGit(fake.api, {
    loadConfig:
      options.loadConfig ??
      (() => ({
        worktreeRoot: options.root,
        trackReferenced: options.trackReferenced ?? true,
        watchIntervalSeconds: 60,
        maxWatches: 10,
      })),
    now: () => (frozen ? clock : (clock += 1)),
    ...(options.runGh ? { runGh: options.runGh } : {}),
    retry: { sleep: async () => undefined },
    onPublish: (snapshot) => snapshots.push(snapshot),
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
  /** The context in another mode, as an RPC host or the terminal runs a command. */
  const inMode = (mode: "tui" | "rpc" | "json" | "print") => ({ ...ctx, mode });
  return {
    pi,
    ctx,
    ui,
    tools,
    commands,
    entries,
    snapshots,
    fire,
    tool,
    ledger,
    shown: fake.shown,
    inMode,
  };
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
      "git_pr_request_review",
      "git_pr_ready",
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

describe("restore card", () => {
  const CARD = "Pull requests and worktrees in this session";
  const COMPACTION = { type: "compaction" };
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
  /** Compact the session: a compaction entry on the branch, then the event. */
  const compact = async (h: Awaited<ReturnType<typeof start>>) => {
    h.entries.push(COMPACTION);
    await h.fire("session_compact");
  };
  /** The cards written to the branch so far, oldest first. */
  const written = (h: Awaited<ReturnType<typeof start>>) => {
    const calls = h.pi.sendMessage.mock.calls.filter(
      ([message]) => (message as { customType?: string }).customType === "git:context",
    );
    for (const [message, options] of calls) {
      expect(message).toMatchObject({ display: false });
      expect(options).toEqual({ triggerTurn: false });
    }
    return calls.map(([message]) => (message as { content: string }).content);
  };
  /** Start a session whose sendMessage appends cards to the branch, as Pi does. */
  const startWriting = async (entries: unknown[] = []) => {
    const h = harness({ sessionId: "parent", cwd: box.dir, root: box.root, entries });
    h.pi.sendMessage.mockImplementation((message: { customType?: string }) => {
      if (message.customType === "git:context")
        h.entries.push({ type: "custom_message", customType: message.customType });
    });
    await h.fire("session_start");
    return h;
  };

  it("uses the worktree repository's remote rather than its directory name", async () => {
    run(box.api, "remote", "add", "origin", "https://github.com/acme/api.git");
    const h = await startWriting();
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
    await compact(h);
    expect(written(h).at(-1)).toContain(`worktree ${path} on fix: no PR yet`);
    h.entries.push({
      ...entry,
      data: { ...entry.data, status: { ...entry.data.status, headRef: "fix" } },
    });
    await compact(h);
    expect(written(h).at(-1)).toContain(`PR 12 "Add login": open, worktree ${path}`);
  });

  it("writes the card for a worktree with a closed PR even without recorded agents", async () => {
    run(box.api, "remote", "add", "origin", "https://github.com/acme/api.git");
    const h = await startWriting();
    await h.tool("git_worktree_create", { repo: "src/api", branch: "fix" });
    const entry = prEntry();
    h.entries.push({
      ...entry,
      data: {
        ...entry.data,
        status: { state: "closed", headRef: "fix", observedAt: 1, source: "bash" },
      },
    });
    await compact(h);
    expect(written(h)).toEqual([
      expect.stringContaining(`worktree ${join(box.root, "api", "fix")} on fix: no open PR`),
    ]);
  });

  it("writes no card for a session with no ledger entries, even after compaction", async () => {
    const h = await startWriting();
    await compact(h);
    await h.tool("git_worktree_create", { repo: "src/api", branch: "feat/x" });
    h.pi.events.emit("subagent:session:created", {
      agentId: "agent-1",
      cwd: join(box.root, "api", "feat-x"),
    });
    expect(written(h)).toEqual([]);
  });

  it.each(["session_start", "session_tree"])(
    "writes nothing after %s on a branch without a compaction",
    async (event) => {
      const h = await startWriting([prEntry()]);
      await h.fire(event);
      expect(written(h)).toEqual([]);
    },
  );

  it("writes one hidden card on resume when a compaction has none, and no other after", async () => {
    const h = await startWriting([prEntry(), COMPACTION]);
    expect(written(h)).toEqual([expect.stringContaining('PR 12 "Add login": open')]);
    expect(written(h)[0]).toContain(CARD);
    await h.fire("session_tree");
    await h.fire("session_start");
    expect(written(h)).toHaveLength(1);
  });

  it("writes a fresh card after each compaction", async () => {
    const h = await startWriting([prEntry()]);
    await compact(h);
    await compact(h);
    expect(written(h)).toHaveLength(2);
  });

  it("writes what the ledger holds at the compaction", async () => {
    const h = await startWriting([prEntry()]);
    h.entries.push({
      ...prEntry(),
      data: { ...prEntry().data, status: { state: "merged", observedAt: 2, source: "bash" } },
    });
    await compact(h);
    expect(written(h)).toEqual([]);
  });

  it("registers no context handler of its own: nothing is added to each request", async () => {
    const h = await startWriting([prEntry(), COMPACTION]);
    for (const [event, handler] of h.pi.on.mock.calls) {
      if (event !== "context") continue;
      const messages = [{ role: "user", content: "hi" }];
      expect(await (handler as (e: unknown, c: unknown) => unknown)({ messages }, h.ctx)).toBe(
        undefined,
      );
    }
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

describe("views", () => {
  it("offers the worktree and pull request explorers and their totals while the session runs", async () => {
    const h = await start();
    const bus = h.pi.events;
    expect(listViews(bus)).toEqual([
      { id: GIT_ATTENTION_VIEW, kind: "attention", title: "Git reviews" },
      { id: GIT_PRS_VIEW, kind: "explorer", title: "Pull requests" },
      { id: GIT_SUMMARY_VIEW, kind: "summary", title: "Git" },
      { id: GIT_WORKTREES_VIEW, kind: "explorer", title: "Git worktrees" },
    ]);
    const summary = () => {
      const model = readView(bus, GIT_SUMMARY_VIEW);
      expect(isViewModel("summary", model)).toBe(true);
      return model as SummaryModel;
    };
    // Nothing recorded yet: zeros, where a session without pi-git has no view.
    expect(summaryCount(summary(), "worktrees")).toBe(0);
    expect(summaryCount(summary(), "prs")).toBe(0);
    const changed: string[] = [];
    onViewChanged(bus, (id) => changed.push(id));
    await h.tool("git_worktree_create", { repo: "src/api", branch: "feat/x" });
    expect(changed).toEqual(
      expect.arrayContaining([GIT_WORKTREES_VIEW, GIT_PRS_VIEW, GIT_SUMMARY_VIEW]),
    );
    const worktrees = readView(bus, GIT_WORKTREES_VIEW) as ExplorerModel;
    expect(worktrees.title).toBe("Git worktrees");
    expect(worktrees.items.map((item) => item.id)).toEqual([join(box.root, "api", "feat-x")]);
    expect((readView(bus, GIT_PRS_VIEW) as ExplorerModel).items).toEqual([]);
    expect(summaryCount(summary(), "worktrees")).toBe(1);

    // A restart restores the totals from the ledger.
    const restarted = await start("parent", h.entries);
    const restored = readView(restarted.pi.events, GIT_SUMMARY_VIEW) as SummaryModel;
    expect(summaryCount(restored, "worktrees")).toBe(1);

    await h.fire("session_shutdown");
    expect(listViews(bus)).toEqual([]);
  });
});

describe("background refresh", () => {
  it("keeps the service withdrawn and writes no card when shutdown interrupts startup", async () => {
    const first = await start();
    await first.tool("git_worktree_create", { repo: "src/api", branch: "shutdown" });
    first.pi.events.emit("subagent:session:created", {
      agentId: "agent-1",
      cwd: join(box.root, "api", "shutdown"),
    });
    // A compaction with no card after it: a start that ran to the end would write one.
    const h = harness({
      sessionId: "interrupted",
      cwd: box.dir,
      root: box.root,
      entries: [...first.entries, { type: "compaction" }],
    });
    const starting = h.fire("session_start");
    await h.fire("session_shutdown");
    await starting;
    expect(service("interrupted", SERVICE_NAME)).toBeUndefined();
    expect(h.pi.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ customType: "git:context" }),
      expect.anything(),
    );
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
    expect(h.ui.notify).not.toHaveBeenCalled();
    expect(h.shown()).toEqual([
      expect.objectContaining({
        customType: "git:output",
        display: true,
        level: "info",
        text: `- ${join(box.root, "api", "feat-x")}\n  api @ feat/x — clean`,
      }),
    ]);
    expect(h.pi.sendMessage).toHaveBeenLastCalledWith(expect.anything(), { triggerTurn: false });
  });

  it("opens the explorer in the terminal and sends no message", async () => {
    const h = await start();
    await h.tool("git_worktree_create", { repo: "src/api", branch: "feat/x" });
    const custom = vi.fn(async () => undefined);
    const ctx = { ...h.inMode("tui"), ui: { ...h.ui, custom } };
    await h.commands.get("git:worktrees")!.handler("", ctx);
    expect(custom).toHaveBeenCalledOnce();
    expect(h.shown()).toEqual([]);
  });

  it("tells a session without dialogs how to remove one instead", async () => {
    const h = await start();
    await h.commands.get("git:worktrees")!.handler("remove", { ...h.ctx, hasUI: false });
    expect(h.shown()).toEqual([
      expect.objectContaining({
        level: "warning",
        text: expect.stringContaining("git_worktree_remove"),
      }),
    ]);
  });

  it("removes a picked worktree through the host's dialogs and reports it as a message", async () => {
    const h = await start();
    await h.tool("git_worktree_create", { repo: "src/api", branch: "wip" });
    const path = join(box.root, "api", "wip");
    await h.commands.get("git:worktrees")!.handler("remove", h.inMode("rpc"));
    expect(h.ui.select).toHaveBeenCalledOnce();
    expect(h.shown().at(-1)).toMatchObject({
      level: "info",
      text: `Removed ${path}; branch wip is kept.`,
    });
    expect(h.ui.notify).not.toHaveBeenCalled();
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
    expect(reloaded.ui.notify).not.toHaveBeenCalled();
    expect(reloaded.shown()).toEqual([
      expect.objectContaining({
        customType: "git:output",
        display: true,
        level: "info",
        text: expect.stringContaining("- acme/api#12"),
      }),
    ]);
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

  it("reads each pull request a list names, once, and reports one it cannot read", async () => {
    const runGh = vi.fn(async (args: readonly string[]) => {
      const number = Number(/pull\/(\d+)/.exec(args[2])?.[1]);
      if (number === 13) throw new Error("HTTP 404: Not Found");
      return view({ number, url: args[2] });
    });
    const h = await withGh(runGh);
    const result = (await h.tool("git_pr_status", {
      pr: ["acme/api#12", "https://github.com/acme/api/pull/13", "acme/api#14", "acme/api#12"],
    })) as unknown as {
      content: { text: string }[];
      structuredContent: { prs: Record<string, unknown>[] };
    };
    expect(runGh.mock.calls.map((call) => call[0][2])).toEqual([
      "https://github.com/acme/api/pull/12",
      "https://github.com/acme/api/pull/13",
      "https://github.com/acme/api/pull/14",
    ]);
    expect(result.structuredContent.prs).toMatchObject([
      { label: "acme/api#12", state: "open" },
      { label: "acme/api#13", error: expect.stringContaining("HTTP 404") },
      { label: "acme/api#14", state: "open" },
    ]);
    expect(result.content[0].text).toContain("- acme/api#13: could not read status:");
  });

  it("reads nothing when a list names something that is not a pull request", async () => {
    const runGh = vi.fn(async () => view());
    const h = await withGh(runGh);
    await expect(h.tool("git_pr_status", { pr: ["acme/api#12", "feat/login"] })).rejects.toThrow(
      'git_pr_status: "feat/login" is not a pull request URL',
    );
    expect(runGh).not.toHaveBeenCalled();
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
    expect(h.shown().at(-1)).toMatchObject({
      level: "info",
      text: "Refreshed 1 of 1 open pull request; worktrees checked.",
    });
    expect(prEntries(h).at(-1)).toMatchObject({
      status: { checks: { passed: 1, failed: 0, pending: 0 } },
      calls: [{ toolCallId: "c1" }, { tool: "/git:refresh" }],
    });
    fail = true;
    await h.commands.get("git:refresh")!.handler("", h.ctx);
    expect(h.shown().at(-1)).toMatchObject({
      level: "warning",
      text: [
        "Refreshed 0 of 1 open pull request; worktrees checked.",
        "acme/api#12: gh is not installed, and no GitHub MCP pull_request_read tool is available to read it instead",
        "Without gh, ask the agent to run git_pr_status, which can read through the GitHub MCP tools.",
      ].join("\n"),
    });
    // The terminal keeps its notification.
    await h.commands.get("git:refresh")!.handler("", h.inMode("tui"));
    expect(h.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Refreshed 0 of 1 open pull request"),
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
  type Result = {
    content: { text: string }[];
    details: { prs: { key: string; watching: boolean; watch?: unknown; error?: string }[] };
  };
  const watching = async (
    runGh: GhRunner,
    options: { entries?: unknown[]; trackReferenced?: boolean; maxWatches?: number } = {},
  ) => {
    const { maxWatches, ...rest } = options;
    const h = harness({
      sessionId: "parent",
      cwd: box.dir,
      root: box.root,
      runGh,
      ...rest,
      ...(maxWatches
        ? {
            loadConfig: () => ({
              worktreeRoot: box.root,
              trackReferenced: true,
              watchIntervalSeconds: 60,
              maxWatches,
            }),
          }
        : {}),
    });
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
    expect(result.details.prs).toMatchObject([
      { key: KEY, watching: true, watch: { key: KEY, until: "settled" } },
    ]);
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
    expect(settled.details.prs[0]!.watching).toBe(false);
    expect(h.watched()).toBeUndefined();
    // Reviews and the merge can still be waited for.
    const open = await h.watch({ until: "merged" });
    expect(open.details.prs[0]!.watching).toBe(true);
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
    expect((await h.watch({ pr: "acme/api#3" })).details.prs[0]!.watching).toBe(true);
  });

  it("takes the cap from the maxWatches setting", async () => {
    const h = await watching(async () => view(), { maxWatches: 2 });
    await h.watch({ pr: "acme/api#1" });
    await h.watch({ pr: "acme/api#2" });
    await expect(h.watch({ pr: "acme/api#3" })).rejects.toThrow(
      "git_pr_watch: 2 pull requests are already watched (the maxWatches setting)",
    );
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

  describe("several in one call", () => {
    const urlOf = (number: number) => `https://github.com/acme/api/pull/${number}`;
    /** gh answers for the PR it is asked about, through `reply` (undefined: not found). */
    const perPr = (reply: (number: number) => Record<string, unknown> | undefined) =>
      vi.fn(async (args: readonly string[]) => {
        const number = Number(/pull\/(\d+)/.exec(args[2])?.[1]);
        const overrides = reply(number);
        if (!overrides) throw new Error("HTTP 404: Not Found");
        return view({ number, url: urlOf(number), ...overrides });
      });

    it("opens one watch per pull request, and each wakes the session on its own", async () => {
      const done = new Set<number>();
      const h = await watching(perPr((number) => (done.has(number) ? failed : {})));
      const result = await h.watch({ pr: ["acme/api#1", "acme/api#2", "acme/api#1"] });
      expect(result.details.prs).toMatchObject([
        { key: "github.com/acme/api#1", watching: true },
        { key: "github.com/acme/api#2", watching: true },
      ]);
      expect(result.content[0].text.split("\n\n")).toHaveLength(2);
      expect(
        h.entries.filter(
          (entry) =>
            (entry as { customType?: string; data?: { op?: string } }).customType === "work:item" &&
            (entry as { data: { op: string } }).data.op === "open",
        ),
      ).toHaveLength(2);
      done.add(2);
      await interval();
      expect(h.messages()).toEqual([
        [
          "Pull request acme/api#2:",
          "Checks finished on head abc123: 1 failed (lint), 1 passed.",
          "The watch has ended.",
          urlOf(2),
        ].join("\n"),
      ]);
      expect(
        h.snapshots
          .at(-1)!
          .prs.filter((pr) => pr.watch)
          .map((pr) => pr.key),
      ).toEqual(["github.com/acme/api#1"]);
    });

    it("watches the others when one cannot be read, and fails when none can", async () => {
      const h = await watching(perPr((number) => (number === 2 ? undefined : {})));
      const result = await h.watch({ pr: ["acme/api#1", "acme/api#2", "acme/api#3"] });
      expect(result.details.prs).toMatchObject([
        { watching: true },
        { key: "github.com/acme/api#2", watching: false, error: "HTTP 404: Not Found" },
        { watching: true },
      ]);
      expect(result.content[0].text).toContain("Could not watch acme/api#2: HTTP 404: Not Found");
      await expect(h.watch({ pr: ["acme/api#2"] })).rejects.toThrow(
        "git_pr_watch: HTTP 404: Not Found",
      );
    });

    it("starts none when they would pass the maxWatches setting", async () => {
      const runGh = perPr(() => ({}));
      const h = await watching(runGh, { maxWatches: 3 });
      await h.watch({ pr: "acme/api#1" });
      runGh.mockClear();
      await expect(
        h.watch({ pr: ["acme/api#1", "acme/api#2", "acme/api#3", "acme/api#4"] }),
      ).rejects.toThrow(
        "git_pr_watch: 3 new watches would pass the maxWatches setting (3) with 1 already watched",
      );
      expect(runGh).not.toHaveBeenCalled();
      // One already watched is not a new watch.
      const result = await h.watch({ pr: ["acme/api#1", "acme/api#2", "acme/api#3"] });
      expect(result.details.prs.map((pr) => pr.watching)).toEqual([true, true, true]);
    });

    it("stops each one named", async () => {
      const h = await watching(perPr(() => ({})));
      await h.watch({ pr: ["acme/api#1", "acme/api#2"] });
      const stopped = await h.watch({ pr: ["acme/api#1", "acme/api#2", "acme/api#3"], stop: true });
      expect(stopped.content[0].text).toBe(
        [
          "Stopped watching acme/api#1.",
          "Stopped watching acme/api#2.",
          "acme/api#3 was not being watched.",
        ].join("\n\n"),
      );
      expect(h.snapshots.at(-1)!.prs.filter((pr) => pr.watch)).toEqual([]);
    });

    it("keeps skipping the call's nested MCP reads while any of its watches runs", async () => {
      const h = await watching(async () => {
        throw new GhUnavailable("gh is not installed");
      });
      const executeTool = vi.fn(
        async (_name: string, args: { method: string; pullNumber: number }) => {
          const body: Record<string, unknown> = {
            get: {
              number: args.pullNumber,
              html_url: urlOf(args.pullNumber),
              state: "open",
              draft: false,
              comments: 0,
              head: { ref: "feat/login", sha: "abc123" },
            },
            get_check_runs: {
              total_count: 1,
              check_runs: [{ name: "unit", status: "in_progress", conclusion: null }],
            },
            get_status: { sha: "abc123", total_count: 0, statuses: [] },
            get_reviews: [],
          };
          return {
            isError: false,
            result: { content: [{ type: "text", text: JSON.stringify(body[args.method]) }] },
          };
        },
      );
      const ctx = { ...h.ctx, executeTool, tools: [{ name: "mcp__github__pull_request_read" }] };
      await h.pi.registerTool.mock.calls
        .map(([tool]) => tool)
        .find((tool) => tool.name === "git_pr_watch")!
        .execute("call-7", { pr: ["acme/api#1", "acme/api#2"] }, undefined, undefined, ctx);
      const nested = () =>
        h.fire("tool_result", {
          toolName: "mcp__github__pull_request_read",
          toolCallId: "call-7/9",
          parentToolCallId: "call-7",
          input: { method: "get", owner: "acme", repo: "api", pullNumber: 5 },
          content: [{ type: "text", text: "{}" }],
          isError: false,
        });
      await h.watch({ pr: "acme/api#1", stop: true });
      const before = h.ledger().length;
      await nested();
      expect(h.ledger()).toHaveLength(before);
      await h.watch({ pr: "acme/api#2", stop: true });
      await nested();
      expect(h.ledger()).toHaveLength(before + 1);
    });
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

describe("review requests", () => {
  const A = "a13c90e".padEnd(40, "0");
  const B = "b24d01f".padEnd(40, "1");
  const KEY = "github.com/acme/web#42";
  const ID = `pr:${KEY}`;
  const requestEntry = (at = 500, head = A, extra: Record<string, unknown> = {}) => ({
    type: "custom",
    customType: ATTENTION_TYPE,
    data: {
      v: 1,
      kind: "request",
      key: KEY,
      host: "github.com",
      owner: "acme",
      repo: "web",
      number: 42,
      head,
      at,
      ...extra,
    },
  });
  const ghView = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      number: 42,
      url: "https://github.com/acme/web/pull/42",
      title: "Checkout cleanup",
      state: "OPEN",
      isDraft: true,
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "MERGEABLE",
      headRefName: "feat/checkout",
      headRefOid: A,
      statusCheckRollup: [],
      ...overrides,
    });
  /** A session whose `gh pr view` answers with whatever `answer` holds at the time. */
  const withGh = async (entries: unknown[], sessionId = "parent") => {
    const answer = { json: ghView() };
    const h = harness({
      sessionId,
      cwd: box.dir,
      root: box.root,
      runGh: async () => answer.json,
      entries,
    });
    await h.fire("session_start");
    return { h, answer };
  };
  const model = (h: { pi: { events: Parameters<typeof readView>[0] } }) => {
    const value = readView(h.pi.events, GIT_ATTENTION_VIEW);
    expect(isViewModel("attention", value)).toBe(true);
    return value as AttentionModel;
  };
  const states = (h: Parameters<typeof model>[0]) =>
    model(h).items.map((item) => `${item.id}:${item.state}`);
  const intents = (h: { entries: unknown[] }) =>
    h.entries
      .filter((entry) => (entry as { customType?: string }).customType === ATTENTION_TYPE)
      .map((entry) => (entry as { data: AttentionEntry }).data);
  const read = (h: Awaited<ReturnType<typeof withGh>>["h"]) =>
    h.tool("git_pr_status", { pr: "acme/web#42" });
  /** A fresh session over the same file: what replay makes of it. */
  const replayed = async (h: { entries: unknown[] }) => (await withGh([...h.entries], "again")).h;

  it("defines an empty view and the dismiss action while the session runs", async () => {
    const h = await start();
    expect(model(h)).toEqual({ items: [], total: 0 });
    expect(listActions(h.pi.events).map((action) => action.id)).toContain(GIT_ATTENTION_DISMISS);
    await h.fire("session_shutdown");
    expect(listActions(h.pi.events)).toEqual([]);
  });

  it("shows a recorded request in a snapshot, and in a settled one without its action", async () => {
    const { h } = await withGh([requestEntry(500, A, { draft: true, reason: "Retry policy" })]);
    const delivered = collectDelivery(h.pi.events, {
      id: "1",
      budget: { maxBytes: 64_000, framingBytes: 64 },
    });
    if (!delivered.ok) throw new Error(delivered.error);
    const entry = delivered.snapshot.views.find((view) => view.id === GIT_ATTENTION_VIEW);
    expect(entry?.model).toEqual({
      items: [
        {
          id: ID,
          rev: A,
          category: "review",
          title: "Review acme/web#42",
          reason: "Retry policy · draft at a13c90e",
          state: "ready",
          since: 500,
          link: { url: "https://github.com/acme/web/pull/42", label: "acme/web#42" },
          dismiss: { action: GIT_ATTENTION_DISMISS, args: { id: ID, rev: A } },
        },
      ],
      total: 1,
    });
    const settled = settleSnapshot(delivered.snapshot, 10_000);
    const kept = settled.views.find((view) => view.id === GIT_ATTENTION_VIEW)?.model as
      | AttentionModel
      | undefined;
    expect(kept?.items).toEqual([
      expect.objectContaining({ id: ID, link: expect.objectContaining({ label: "acme/web#42" }) }),
    ]);
    expect(kept?.items[0]?.dismiss).toBeUndefined();
  });

  it("follows the PR's facts live, and replay reaches the same rows at each step", async () => {
    const { h, answer } = await withGh([requestEntry(500, A, { draft: true })]);
    const changed: string[] = [];
    onViewChanged(h.pi.events, (id) => changed.push(id));

    // The same head, still a draft: ready, now with when it was last seen.
    await read(h);
    expect(states(h)).toEqual([`${ID}:ready`]);
    expect(model(h).items[0]!.observedAt).toBeGreaterThan(500);
    expect(model(await replayed(h))).toEqual(model(h));

    // A push: stale, at the head that was handed off.
    answer.json = ghView({ headRefOid: B });
    await read(h);
    expect(changed).toContain(GIT_ATTENTION_VIEW);
    expect(model(h).items[0]).toMatchObject({ state: "stale", rev: A });
    expect(model(await replayed(h))).toEqual(model(h));

    // Marked ready for review: a stale request is not resolved by it.
    answer.json = ghView({ headRefOid: B, isDraft: false });
    await read(h);
    expect(states(h)).toEqual([`${ID}:stale`]);

    // Merged: gone, and gone after replay.
    answer.json = ghView({ headRefOid: B, isDraft: false, state: "MERGED" });
    await read(h);
    expect(model(h)).toEqual({ items: [], total: 0 });
    expect(model(await replayed(h))).toEqual({ items: [], total: 0 });
    expect(intents(h)).toHaveLength(1);
  });

  it("resolves a draft request marked ready for review at the same head", async () => {
    const { h, answer } = await withGh([requestEntry(500, A, { draft: true })]);
    answer.json = ghView({ isDraft: false });
    await read(h);
    expect(model(h).items).toEqual([]);
  });

  it("dismisses with one entry, and the row stays gone after reload and /tree", async () => {
    const { h } = await withGh([requestEntry()]);
    await expect(
      dispatchAction(h.pi.events, GIT_ATTENTION_DISMISS, { id: ID, rev: A }),
    ).resolves.toEqual({ dismissed: true });
    expect(model(h).items).toEqual([]);
    expect(intents(h).map((entry) => entry.kind)).toEqual(["request", "dismissal"]);
    expect(intents(h)[1]).toMatchObject({ key: KEY, head: A });
    await h.fire("session_tree");
    expect(model(h).items).toEqual([]);
    expect(model(await replayed(h)).items).toEqual([]);
  });

  it("refuses to dismiss another revision, an unknown item or malformed arguments", async () => {
    const { h } = await withGh([requestEntry()]);
    const dismiss = (args: Record<string, unknown>) =>
      dispatchAction(h.pi.events, GIT_ATTENTION_DISMISS, args as never);
    await expect(dismiss({ id: ID, rev: B })).rejects.toThrow("changed since it was shown");
    await expect(dismiss({ id: "pr:github.com/acme/web#43", rev: A })).rejects.toThrow(
      "No review request",
    );
    await expect(dismiss({ id: ID })).rejects.toThrow("Invalid arguments");
    expect(intents(h)).toHaveLength(1);
    expect(states(h)).toEqual([`${ID}:ready`]);
  });

  it("restores the rows on /tree from every branch", async () => {
    const { h } = await withGh([]);
    expect(model(h).items).toEqual([]);
    h.entries.push(requestEntry());
    await h.fire("session_tree");
    expect(states(h)).toEqual([`${ID}:ready`]);
  });

  describe("git_pr_request_review", () => {
    const requestReview = (h: Awaited<ReturnType<typeof withGh>>["h"], extra = {}) =>
      h.tool("git_pr_request_review", { pr: "acme/web#42", head: A, ...extra });
    const WATCH_CALL =
      'git_pr_watch { pr: "https://github.com/acme/web/pull/42", until: "merged" }';

    it("records a request at the checked head and says no watch keeps it current", async () => {
      const { h } = await withGh([]);
      const result = await requestReview(h, { reason: "Step 3: retry policy" });
      expect(result.content[0].text).toBe(
        [
          "Requested review of acme/web#42 at a13c90e00000. It waits on the user until they mark it ready for review, approve, merge or close it, or dismiss it; a push makes it stale.",
          `No git_pr_watch is open on it: call ${WATCH_CALL} so the request follows it while this session runs. Without one, nothing updates the request until the pull request is read again.`,
        ].join("\n"),
      );
      expect(result.details).toEqual({ requested: true, key: KEY, head: A, state: "ready" });
      expect(intents(h)).toEqual([
        expect.objectContaining({
          kind: "request",
          key: KEY,
          head: A,
          draft: true,
          reason: "Step 3: retry policy",
        }),
      ]);
      // What it read is in the ledger, before the request, so it is not taken as a later fact.
      const order = h.entries.map((entry) => (entry as { customType?: string }).customType);
      expect(order.indexOf(LEDGER_TYPE)).toBeLessThan(order.indexOf(ATTENTION_TYPE));
      expect(states(h)).toEqual([`${ID}:ready`]);
      expect(model(h).items[0]).toMatchObject({
        reason: "Step 3: retry policy · draft at a13c90e",
      });
    });

    it("records nothing for a retry at the same head, without reading GitHub", async () => {
      const runGh = vi.fn(async () => ghView());
      const h = harness({ sessionId: "parent", cwd: box.dir, root: box.root, runGh });
      await h.fire("session_start");
      await requestReview(h as never);
      const reads = runGh.mock.calls.length;
      const again = await requestReview(h as never);
      expect(again.content[0].text).toMatch(
        /^Review of acme\/web#42 at a13c90e00000 is already requested; nothing recorded\.\n/,
      );
      expect(again.details).toMatchObject({ requested: false });
      expect(runGh.mock.calls.length).toBe(reads);
      expect(intents(h)).toHaveLength(1);
    });

    it("requests again at the new head after a push made the request stale", async () => {
      const { h, answer } = await withGh([requestEntry()]);
      answer.json = ghView({ headRefOid: B, isDraft: false });
      await read(h);
      expect(states(h)).toEqual([`${ID}:stale`]);
      const result = await requestReview(h, { head: B });
      expect(result.content[0].text).toMatch(
        /^Requested review of acme\/web#42 at b24d01f11111 \(the request at a13c90e00000 was stale\)\. It waits on the user until they approve, merge or close it, or dismiss it;/,
      );
      expect(model(h).items).toEqual([expect.objectContaining({ rev: B, state: "ready" })]);
    });

    it("refuses a head GitHub does not show, a closed PR or a short SHA, and records no request", async () => {
      const { h, answer } = await withGh([]);
      await expect(requestReview(h, { head: B })).rejects.toThrow(
        "git_pr_request_review: acme/web#42's head is a13c90e00000 on GitHub, not b24d01f11111",
      );
      answer.json = ghView({ state: "CLOSED" });
      await expect(requestReview(h)).rejects.toThrow("acme/web#42 is closed, not open");
      await expect(requestReview(h, { head: "a13c90e" })).rejects.toThrow(
        "is not a full commit SHA",
      );
      await expect(requestReview(h, { pr: "not a pr" })).rejects.toThrow(
        "is not a pull request URL",
      );
      expect(intents(h)).toEqual([]);
      expect(model(h).items).toEqual([]);
    });

    it("says the watch keeps it current when one runs until merged, and when one ends sooner", async () => {
      const { h } = await withGh([]);
      await h.tool("git_pr_watch", { pr: "acme/web#42", until: "merged" });
      const watched = await requestReview(h);
      expect(watched.content[0].text).toMatch(
        /\ngit_pr_watch is watching it until it is merged or closed, so the request follows it while this session runs\.$/,
      );
      expect(watched.details).toMatchObject({ watching: "merged" });
      await h.tool("git_pr_watch", { pr: "acme/web#42", stop: true });
      // Checks still running, so a "settled" watch stays open, and ends when they finish.
      const { h: other } = await withGh([], "other");
      await other.tool("git_pr_watch", { pr: "acme/web#42" });
      const settled = await requestReview(other);
      expect(settled.content[0].text).toContain(
        `The watch on it ends when checks finish: call ${WATCH_CALL}`,
      );
      await other.tool("git_pr_watch", { pr: "acme/web#42", stop: true });
    });

    it("is refused in a subagent", async () => {
      const { h: parent } = await withGh([]);
      parent.pi.events.emit("subagent:session:created", {
        sessionId: "child",
        parentSessionId: "parent",
        agentId: "agent-7",
        cwd: box.dir,
      });
      const { h: child } = await withGh([], "child");
      await expect(requestReview(child)).rejects.toThrow(
        "git_pr_request_review: only the main session hands pull requests to the user",
      );
      expect(intents(child)).toEqual([]);
      expect(intents(parent)).toEqual([]);
    });
  });

  it("takes a subagent's facts but not its intent", async () => {
    const { h: parent } = await withGh([requestEntry()]);
    parent.pi.events.emit("subagent:session:created", {
      sessionId: "child",
      parentSessionId: "parent",
      agentId: "agent-7",
      cwd: box.dir,
    });
    const child = await start("child", [
      requestEntry(600, A, { key: "github.com/acme/web#43", number: 43 }),
    ]);
    // The child's own request stays in the child.
    expect(model(child).items.map((item) => item.id)).toEqual(["pr:github.com/acme/web#43"]);
    await child.fire("tool_result", {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "k1",
      input: { command: "gh pr view 42 -R acme/web" },
      content: [{ type: "text", text: "state:\tMERGED" }],
      isError: false,
    });
    expect(model(parent).items).toEqual([]);
    expect(intents(parent)).toHaveLength(1);
    expect(model(await replayed(parent)).items).toEqual([]);
  });
});

describe("git_pr_ready", () => {
  const A = "a13c90e".padEnd(40, "0");
  const B = "b24d01f".padEnd(40, "1");
  const C = "c35e12a".padEnd(40, "2");

  /** A fake GitHub behind `gh`: pull requests by number in acme/web, changed by the writes. */
  const fakeGh = (initial: Record<number, Record<string, unknown>>) => {
    const prs = new Map(
      Object.entries(initial).map(([n, pr]) => [
        Number(n),
        {
          state: "OPEN",
          isDraft: true,
          headRefOid: A,
          autoMergeRequest: null,
          reviewDecision: "REVIEW_REQUIRED",
          ...pr,
        } as Record<string, unknown>,
      ]),
    );
    /** Called before every `gh pr view`, so a test can push in between. */
    const hooks = { beforeView: (_n: number, _views: number) => {} };
    let views = 0;
    const number = (url: string) => Number(/pull\/(\d+)/.exec(url)?.[1]);
    const run = vi.fn(async (args: readonly string[]) => {
      const [noun, verb] = args;
      if (noun === "repo" && verb === "view")
        return JSON.stringify({ viewerDefaultMergeMethod: "SQUASH" });
      const n = number(args[2]);
      const pr = prs.get(n);
      if (!pr) throw new Error(`no pull request ${n}`);
      if (verb === "view") {
        hooks.beforeView(n, (views += 1));
        return JSON.stringify({
          number: n,
          url: `https://github.com/acme/web/pull/${n}`,
          title: `PR ${n}`,
          mergeable: "MERGEABLE",
          headRefName: `feat/${n}`,
          statusCheckRollup: [],
          ...pr,
        });
      }
      if (verb === "ready") {
        pr.isDraft = false;
        return "";
      }
      if (verb === "merge") {
        if (args.includes("--disable-auto")) {
          pr.autoMergeRequest = null;
          return "";
        }
        const expected = args[args.indexOf("--match-head-commit") + 1];
        if (expected !== pr.headRefOid) throw new Error("Head branch was modified");
        if (pr.clean) pr.state = "MERGED";
        else pr.autoMergeRequest = { mergeMethod: "SQUASH" };
        return "";
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    });
    return { run, prs, hooks };
  };
  const writes = (run: ReturnType<typeof fakeGh>["run"]) =>
    run.mock.calls
      .map((call) => call[0])
      .filter((args) => !(args[0] === "pr" && args[1] === "view"));
  const session = async (runGh: GhRunner, entries: unknown[] = [], sessionId = "parent") => {
    const h = harness({
      sessionId,
      cwd: box.dir,
      root: box.root,
      runGh,
      entries,
    });
    await h.fire("session_start");
    return h;
  };
  type Ready = {
    content: { text: string }[];
    structuredContent: { prs: Record<string, unknown>[] };
  };
  const ready = (h: Awaited<ReturnType<typeof session>>, params: Record<string, unknown>) =>
    h.tool("git_pr_ready", params) as unknown as Promise<Ready>;
  const intents = (h: { entries: unknown[] }) =>
    h.entries
      .filter((entry) => (entry as { customType?: string }).customType === ATTENTION_TYPE)
      .map((entry) => (entry as { data: AttentionEntry }).data);
  const attention = (h: { pi: { events: Parameters<typeof readView>[0] } }) =>
    (readView(h.pi.events, GIT_ATTENTION_VIEW) as AttentionModel).items;

  it("marks each ready and turns on auto-merge at the reviewed head, in one call", async () => {
    const gh = fakeGh({ 1: {}, 2: { isDraft: false, headRefOid: B } });
    const h = await session(gh.run);
    const result = await ready(h, {
      prs: [
        { pr: "acme/web#1", head: A },
        { pr: "https://github.com/acme/web/pull/2", head: B },
      ],
      autoMerge: true,
    });
    expect(writes(gh.run)).toEqual([
      ["pr", "ready", "https://github.com/acme/web/pull/1"],
      ["repo", "view", "github.com/acme/web", "--json", "viewerDefaultMergeMethod"],
      [
        "pr",
        "merge",
        "https://github.com/acme/web/pull/1",
        "--auto",
        "--squash",
        "--match-head-commit",
        A,
      ],
      // The default merge method is read once per repository.
      [
        "pr",
        "merge",
        "https://github.com/acme/web/pull/2",
        "--auto",
        "--squash",
        "--match-head-commit",
        B,
      ],
    ]);
    expect(result.content[0].text).toBe(
      [
        "Marked 2 of 2 pull requests.",
        "- acme/web#1 at a13c90e00000: marked ready for review; auto-merge on (squash)",
        "  https://github.com/acme/web/pull/1",
        "- acme/web#2 at b24d01f11111: already ready for review; auto-merge on (squash)",
        "  https://github.com/acme/web/pull/2",
      ].join("\n"),
    );
    expect(result.structuredContent.prs[0]).toEqual({
      key: "github.com/acme/web#1",
      label: "acme/web#1",
      url: "https://github.com/acme/web/pull/1",
      head: A,
      ready: "marked",
      autoMerge: "enabled",
      method: "squash",
      state: "open",
    });
    // What it read before and after is in the ledger, as the tool's own calls.
    expect(h.snapshots.at(-1)!.prs.find((pr) => pr.number === 1)).toMatchObject({
      status: { draft: false },
      calls: [{ tool: "git_pr_ready" }],
    });
  });

  it("counts a ready PR with auto-merge on as done, and writes nothing for it", async () => {
    const gh = fakeGh({
      1: { isDraft: false, autoMergeRequest: { mergeMethod: "MERGE" } },
    });
    const h = await session(gh.run);
    const result = await ready(h, {
      prs: [{ pr: "acme/web#1", head: A }],
      autoMerge: "rebase",
    });
    expect(writes(gh.run)).toEqual([]);
    expect(result.content[0].text).toContain(
      "- acme/web#1 at a13c90e00000: already ready for review; auto-merge was already on",
    );
  });

  it("uses the merge method given, and reports a PR gh merged at once", async () => {
    const gh = fakeGh({ 1: { isDraft: false, clean: true } });
    const h = await session(gh.run);
    const result = await ready(h, {
      prs: [{ pr: "acme/web#1", head: A }],
      autoMerge: "merge",
    });
    expect(writes(gh.run)).toEqual([
      [
        "pr",
        "merge",
        "https://github.com/acme/web/pull/1",
        "--auto",
        "--merge",
        "--match-head-commit",
        A,
      ],
    ]);
    expect(result.structuredContent.prs[0]).toMatchObject({
      autoMerge: "merged",
      state: "merged",
    });
    expect(result.content[0].text).toContain("already ready for review; merged (merge)");
  });

  it("refuses a PR whose head is not the reviewed one and goes on with the others", async () => {
    const gh = fakeGh({ 1: { headRefOid: C }, 2: {} });
    const h = await session(gh.run);
    const result = await ready(h, {
      prs: [
        { pr: "acme/web#1", head: A },
        { pr: "acme/web#2", head: A },
      ],
    });
    expect(writes(gh.run)).toEqual([["pr", "ready", "https://github.com/acme/web/pull/2"]]);
    expect(result.content[0].text).toBe(
      [
        "Marked 1 of 2 pull requests.",
        "- acme/web#1 at a13c90e00000: not marked: its head is c35e12a22222 on GitHub, not a13c90e00000: it changed since that review, so show the user the new head",
        "  https://github.com/acme/web/pull/1",
        "- acme/web#2 at a13c90e00000: marked ready for review",
        "  https://github.com/acme/web/pull/2",
      ].join("\n"),
    );
  });

  it("fails when no PR could be marked: no head, a short SHA, a closed PR, not a PR", async () => {
    const gh = fakeGh({ 1: {}, 2: { state: "CLOSED" } });
    const h = await session(gh.run);
    await expect(
      ready(h, {
        prs: [
          { pr: "acme/web#1" },
          { pr: "acme/web#3", head: "a13c90e" },
          { pr: "acme/web#2", head: A },
          { pr: "not a pr" },
          // The same pull request again is left out.
          { pr: "https://github.com/acme/web/pull/1", head: A },
        ],
      }),
    ).rejects.toThrow(
      [
        "git_pr_ready: Marked 0 of 4 pull requests.",
        "- acme/web#1: not marked: no head given and no review request waits on the user for it: pass the full head SHA the user reviewed",
        "  https://github.com/acme/web/pull/1",
        '- acme/web#3: not marked: "a13c90e" is not a full commit SHA: pass the 40-character head SHA the user reviewed',
        "  https://github.com/acme/web/pull/3",
        "- acme/web#2 at a13c90e00000: not marked: it is closed, not open",
        "  https://github.com/acme/web/pull/2",
        "- not a pr: not marked: not a pull request URL, owner/repo#number, or a number in this repository",
      ].join("\n"),
    );
    expect(writes(gh.run)).toEqual([]);
    await expect(ready(h, { prs: [{ pr: "acme/web#1", head: A }], ready: false })).rejects.toThrow(
      "git_pr_ready: nothing to do",
    );
  });

  it("takes the head of the review request waiting on the user, and resolves it", async () => {
    const gh = fakeGh({ 1: { isDraft: false } });
    const h = await session(gh.run);
    await h.tool("git_pr_request_review", { pr: "acme/web#1", head: A });
    expect(attention(h)).toHaveLength(1);
    const result = await ready(h, {
      prs: [{ pr: "acme/web#1" }],
      autoMerge: true,
    });
    expect(result.content[0].text).toContain(
      "- acme/web#1 at a13c90e00000: already ready for review; auto-merge on (squash); review request resolved",
    );
    expect(intents(h).map((entry) => entry.kind)).toEqual(["request", "dismissal"]);
    expect(attention(h)).toEqual([]);
  });

  it("does not write a dismissal when marking a draft ready already resolved the request", async () => {
    const gh = fakeGh({ 1: {} });
    const h = await session(gh.run);
    await h.tool("git_pr_request_review", { pr: "acme/web#1", head: A });
    const result = await ready(h, { prs: [{ pr: "acme/web#1" }] });
    expect(result.structuredContent.prs[0]).toMatchObject({
      ready: "marked",
      dismissed: true,
    });
    expect(intents(h).map((entry) => entry.kind)).toEqual(["request"]);
    expect(attention(h)).toEqual([]);
  });

  it("turns auto-merge off again when the head moved while marking", async () => {
    const gh = fakeGh({ 1: { isDraft: false } });
    // The second read, after the writes, sees a push.
    gh.hooks.beforeView = (n, views) => {
      if (views === 2) gh.prs.get(n)!.headRefOid = B;
    };
    const h = await session(gh.run);
    await expect(
      ready(h, { prs: [{ pr: "acme/web#1", head: A }], autoMerge: "squash" }),
    ).rejects.toThrow(
      "- acme/web#1 at a13c90e00000: already ready for review; then failed: its head moved to b24d01f11111 while it was being marked, so auto-merge was turned off again: show the user the new head",
    );
    expect(writes(gh.run).at(-1)).toEqual([
      "pr",
      "merge",
      "https://github.com/acme/web/pull/1",
      "--disable-auto",
    ]);
    expect(gh.prs.get(1)!.autoMergeRequest).toBeNull();
  });

  it("is refused in a subagent", async () => {
    const gh = fakeGh({ 1: {} });
    const parent = await session(gh.run);
    parent.pi.events.emit("subagent:session:created", {
      sessionId: "child",
      parentSessionId: "parent",
      agentId: "agent-7",
      cwd: box.dir,
    });
    const child = await session(gh.run, [], "child");
    await expect(ready(child, { prs: [{ pr: "acme/web#1", head: A }] })).rejects.toThrow(
      "git_pr_ready: only the main session marks pull requests ready",
    );
    expect(gh.run).not.toHaveBeenCalled();
  });

  describe("through the GitHub MCP tools", () => {
    /** A fake GitHub behind the MCP tools, for acme/web#1. */
    const mcp = (pr: Record<string, unknown>) => {
      const state = {
        state: "open",
        draft: true,
        sha: A,
        auto_merge: null as unknown,
        clean: false,
        ...pr,
      };
      let gets = 0;
      const hooks = { afterGets: (_gets: number) => {} };
      const executeTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
        const ok = (value: unknown) => ({
          isError: false,
          result: {
            content: [{ type: "text", text: JSON.stringify(value) }],
          },
        });
        const fail = (text: string) => ({
          isError: true,
          result: { content: [{ type: "text", text }] },
        });
        if (name === "mcp__github__pull_request_read") {
          if (args.method === "get") {
            hooks.afterGets((gets += 1));
            return ok({
              number: 1,
              html_url: "https://github.com/acme/web/pull/1",
              state: state.state === "merged" ? "closed" : state.state,
              merged: state.state === "merged",
              draft: state.draft,
              auto_merge: state.auto_merge,
              head: { sha: state.sha, ref: "feat/1" },
            });
          }
          if (args.method === "get_check_runs") return ok({ total_count: 0, check_runs: [] });
          if (args.method === "get_status")
            return ok({ sha: state.sha, total_count: 0, statuses: [] });
          return ok([]);
        }
        if (name === "mcp__github__update_pull_request") {
          state.draft = args.draft as boolean;
          return ok({});
        }
        if (name === "mcp__github__enable_pr_auto_merge") {
          if (state.clean) return fail("Pull request is in clean status");
          state.auto_merge = { merge_method: args.mergeMethod ?? "default" };
          return ok({});
        }
        if (name === "mcp__github__disable_pr_auto_merge") {
          state.auto_merge = null;
          return ok({});
        }
        if (name === "mcp__github__merge_pull_request") {
          if (args.expectedHeadSha !== state.sha) return fail("Head branch was modified");
          state.state = "merged";
          return ok({ merged: true });
        }
        return fail(`unexpected ${name}`);
      });
      const tools = [
        "mcp__github__pull_request_read",
        "mcp__github__update_pull_request",
        "mcp__github__enable_pr_auto_merge",
        "mcp__github__disable_pr_auto_merge",
        "mcp__github__merge_pull_request",
      ].map((name) => ({ name }));
      return { executeTool, tools, state, hooks };
    };
    const noGh: GhRunner = async () => {
      throw new GhUnavailable("gh is not installed");
    };
    const mcpWrites = (executeTool: ReturnType<typeof mcp>["executeTool"]) =>
      executeTool.mock.calls
        .filter(([name]) => name !== "mcp__github__pull_request_read")
        .map(([name, args]) => [name, args]);
    const withMcp = async (fake: ReturnType<typeof mcp>) => {
      const h = await session(noGh);
      Object.assign(h.ctx, {
        executeTool: fake.executeTool,
        tools: fake.tools,
      });
      return h;
    };

    it("marks it ready and turns on auto-merge with the repository's default method", async () => {
      const fake = mcp({});
      const h = await withMcp(fake);
      const result = await ready(h, {
        prs: [{ pr: "acme/web#1", head: A }],
        autoMerge: true,
      });
      expect(mcpWrites(fake.executeTool)).toEqual([
        [
          "mcp__github__update_pull_request",
          { owner: "acme", repo: "web", pullNumber: 1, draft: false },
        ],
        ["mcp__github__enable_pr_auto_merge", { owner: "acme", repo: "web", pullNumber: 1 }],
      ]);
      expect(result.content[0].text).toContain(
        "marked ready for review; auto-merge on (repository default)",
      );
    });

    it("merges at the reviewed head when nothing is left to wait for and a method is given", async () => {
      const fake = mcp({ draft: false, clean: true });
      const h = await withMcp(fake);
      const result = await ready(h, {
        prs: [{ pr: "acme/web#1", head: A }],
        autoMerge: "squash",
      });
      expect(mcpWrites(fake.executeTool).at(-1)).toEqual([
        "mcp__github__merge_pull_request",
        {
          owner: "acme",
          repo: "web",
          pullNumber: 1,
          merge_method: "squash",
          expectedHeadSha: A,
        },
      ]);
      expect(result.structuredContent.prs[0]).toMatchObject({
        autoMerge: "merged",
        method: "squash",
      });
    });

    it("asks for a method when it could merge now but the default is unknown", async () => {
      const fake = mcp({ draft: false, clean: true });
      const h = await withMcp(fake);
      await expect(
        ready(h, { prs: [{ pr: "acme/web#1", head: A }], autoMerge: true }),
      ).rejects.toThrow('pass autoMerge "squash", "merge" or "rebase" to merge it');
      expect(fake.state.state).toBe("open");
    });

    it("turns auto-merge off again when the head moved, since the tool cannot pin it", async () => {
      const fake = mcp({ draft: false });
      // The first read makes two gets; the read after the writes sees a push.
      fake.hooks.afterGets = (gets) => {
        if (gets === 3) fake.state.sha = B;
      };
      const h = await withMcp(fake);
      await expect(
        ready(h, { prs: [{ pr: "acme/web#1", head: A }], autoMerge: true }),
      ).rejects.toThrow("so auto-merge was turned off again");
      expect(fake.state.auto_merge).toBeNull();
    });
  });
});
