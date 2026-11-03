import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_TREE_KEY } from "../../../packages/pi-session-tree/src/index.ts";
import { GIT_SNAPSHOT_EVENT, type GitSnapshotEvent } from "../src/events.ts";
import piGit from "../src/index.ts";
import { LEDGER_TYPE, type WorktreeRecord } from "../src/ledger.ts";
import { commit, sandbox, type Sandbox } from "./support/repos.ts";

type Handler = (...args: unknown[]) => unknown;
interface Tool {
  name: string;
  execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: unknown }>;
}

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
}) {
  const handlers = new Map<string, Handler[]>();
  const listeners = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, { handler: Handler }>();
  const entries: unknown[] = [...(options.entries ?? [])];
  const snapshots: GitSnapshotEvent[] = [];
  const pi = {
    on: vi.fn((event: string, handler: Handler) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    ),
    registerTool: vi.fn((tool: Tool) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: { handler: Handler }) =>
      commands.set(name, command),
    ),
    appendEntry: vi.fn((customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
    ),
    events: {
      on: (channel: string, handler: Handler) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
        return () => undefined;
      },
      emit: (channel: string, data: unknown) => {
        for (const handler of listeners.get(channel) ?? []) handler(data);
      },
    },
  };
  pi.events.on(GIT_SNAPSHOT_EVENT, (data) => snapshots.push(data as GitSnapshotEvent));
  piGit(pi as unknown as ExtensionAPI, {
    loadConfig: () => ({
      worktreeRoot: options.root,
      trackReferenced: options.trackReferenced ?? true,
    }),
    now: () => (frozen ? clock : (clock += 1)),
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
    },
  };
  const fire = async (event: string, data: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(data, ctx);
  };
  const tool = async (name: string, params: Record<string, unknown>) =>
    tools.get(name)!.execute("call-1", params, undefined, undefined, ctx);
  const ledger = () =>
    entries
      .filter((entry) => (entry as { customType?: string }).customType === LEDGER_TYPE)
      .map((entry) => (entry as { data: WorktreeRecord }).data);
  return { pi, ctx, ui, tools, commands, entries, snapshots, fire, tool, ledger };
}

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
  clock = 1_000;
  frozen = false;
});
afterEach(() => {
  box.cleanup();
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Symbol-keyed global in tests
  delete (globalThis as Record<symbol, unknown>)[SESSION_TREE_KEY];
});

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
    ]);
    expect(h.commands.has("git:worktrees")).toBe(true);
    expect(h.commands.has("git:prs")).toBe(true);
    for (const event of ["session_start", "session_tree", "session_shutdown", "tool_result"])
      expect(h.pi.on).toHaveBeenCalledWith(event, expect.any(Function));
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
    const service = (await import("../../../packages/pi-session-tree/src/index.ts")).service<{
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

  it("never fails a tool result it cannot read", async () => {
    const h = await start();
    await expect(h.fire("tool_result", { toolName: "bash", input: null })).resolves.toBeUndefined();
    expect(prs(h)).toEqual([]);
  });
});
