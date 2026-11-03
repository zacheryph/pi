import { describe, expect, it } from "vitest";
import { clip, readGit, readPreview, readStash, readTodoHistory, readTodos } from "#src/sections";

const task = (overrides: Record<string, unknown> = {}) => ({
  key: "a",
  subject: "Add retry backoff",
  status: "in_progress",
  blocked: false,
  unreviewed: 0,
  updates: [],
  ...overrides,
});

const entry = (overrides: Record<string, unknown> = {}) => ({
  handle: "stash:notes@0123456789ab",
  name: "notes",
  hash: "0".repeat(64),
  bytes: 10,
  lines: 2,
  mime: "text/plain",
  createdAt: 1_700_000_000_000,
  createdBy: "session-a",
  source: "content",
  versions: 1,
  ...overrides,
});

describe("clip", () => {
  it("keeps line breaks, drops other controls, trims and caps", () => {
    expect(clip("  a\r\nb\u001b[2J\tc  ", 50)).toBe("a\nb [2J c");
    expect(clip("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
    expect(clip(" \n ", 10)).toBeUndefined();
    expect(clip(3, 10)).toBeUndefined();
  });
});

describe("readTodos", () => {
  it("keeps what the dashboard shows: status, blocking, review count and the latest message", () => {
    const result = readTodos({
      version: 1,
      revision: 4,
      tasks: [
        task({
          description: "cap at 8s",
          dependsOn: ["root"],
          createdAt: 10,
          unreviewed: 2,
          updates: [
            { revision: 2, at: 20, status: "in_progress", message: "started" },
            { revision: 3, at: 30, status: "in_progress", message: "jitter added" },
            { revision: 4, at: 40, status: "in_progress" },
          ],
        }),
        task({ key: "b", subject: "Write test", status: "pending", blocked: true }),
      ],
    });
    expect(result).toEqual({
      revision: 4,
      total: 2,
      tasks: [
        {
          key: "a",
          subject: "Add retry backoff",
          status: "in_progress",
          blocked: false,
          unreviewed: 2,
          description: "cap at 8s",
          dependsOn: ["root"],
          message: { text: "jitter added", at: 30 },
          updatedAt: 40,
        },
        { key: "b", subject: "Write test", status: "pending", blocked: true, unreviewed: 0 },
      ],
    });
  });

  it("drops malformed tasks and rejects unknown payload versions", () => {
    expect(
      readTodos({
        version: 1,
        revision: 1,
        tasks: [task({ status: "done" }), task({ key: "" }), null, task()],
      })?.tasks,
    ).toHaveLength(1);
    expect(readTodos({ version: 2, revision: 1, tasks: [] })).toBeUndefined();
    expect(readTodos({ version: 1 })).toBeUndefined();
    expect(readTodos("nope")).toBeUndefined();
  });

  it("caps long text and the number of tasks", () => {
    const tasks = Array.from({ length: 150 }, (_, index) =>
      task({ key: `t${index}`, description: "d".repeat(2_000) }),
    );
    const result = readTodos({ version: 1, revision: 1, tasks })!;
    expect(result.total).toBe(150);
    expect(result.tasks).toHaveLength(100);
    expect(result.tasks[0]?.description).toHaveLength(500);
  });
});

describe("readStash", () => {
  it("keeps entry metadata in order", () => {
    expect(
      readStash({
        version: 1,
        entries: [
          entry({ description: "auth audit" }),
          entry({ name: "log", source: "tool:bash", versions: 3 }),
        ],
      }),
    ).toEqual({
      total: 2,
      entries: [
        {
          name: "notes",
          handle: "stash:notes@0123456789ab",
          bytes: 10,
          lines: 2,
          mime: "text/plain",
          source: "content",
          createdAt: 1_700_000_000_000,
          createdBy: "session-a",
          versions: 1,
          description: "auth audit",
        },
        {
          name: "log",
          handle: "stash:notes@0123456789ab",
          bytes: 10,
          lines: 2,
          mime: "text/plain",
          source: "tool:bash",
          createdAt: 1_700_000_000_000,
          createdBy: "session-a",
          versions: 3,
        },
      ],
    });
  });

  it("drops malformed entries, never carries content, and rejects unknown versions", () => {
    const result = readStash({
      version: 1,
      entries: [entry({ bytes: -1 }), entry({ name: 5 }), entry({ content: "secret" })],
    });
    expect(result?.entries).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(readStash({ version: 3, entries: [] })).toBeUndefined();
  });
});

describe("readStash store size", () => {
  it("passes the store size and cap through, and drops malformed ones", () => {
    expect(
      readStash({ version: 1, entries: [], store: { bytes: 5, maxBytes: 10 } })?.store,
    ).toEqual({ bytes: 5, maxBytes: 10 });
    expect(
      readStash({ version: 1, entries: [], store: { bytes: -1, maxBytes: 10 } })?.store,
    ).toBeUndefined();
    expect(readStash({ version: 1, entries: [] })?.store).toBeUndefined();
  });
});

describe("readTodoHistory", () => {
  const event = {
    version: 1,
    revision: 3,
    tasks: [
      task({
        key: "a",
        createdAt: 5,
        updates: [
          { revision: 1, at: 10, status: "in_progress", from: "pending", by: "user" },
          {
            revision: 2,
            at: 20,
            status: "completed",
            from: "in_progress",
            message: "x".repeat(3_000),
          },
          { revision: 3, at: 0, status: "completed" },
          { revision: 4, at: 30, status: "done" },
        ],
      }),
    ],
  };

  it("returns one task's history with validated updates", () => {
    const history = readTodoHistory(event, "a")!;
    expect(history.createdAt).toBe(5);
    expect(history.updates).toHaveLength(2);
    expect(history.updates[0]).toEqual({
      revision: 1,
      at: 10,
      status: "in_progress",
      from: "pending",
      byUser: true,
    });
    expect(history.updates[1]?.message).toHaveLength(2_000);
  });

  it("is undefined for unknown tasks and payloads", () => {
    expect(readTodoHistory(event, "missing")).toBeUndefined();
    expect(readTodoHistory(undefined, "a")).toBeUndefined();
    expect(readTodoHistory({ version: 2, tasks: [] }, "a")).toBeUndefined();
  });
});

describe("readPreview", () => {
  it("passes a valid preview, capped, and turns failures into messages", () => {
    expect(
      readPreview({
        ok: true,
        handle: "stash:a@0123456789ab",
        lines: ["one", 2, "three"],
        total: 9,
        complete: false,
      }),
    ).toEqual({
      handle: "stash:a@0123456789ab",
      lines: ["one", "", "three"],
      total: 9,
      complete: false,
    });
    const long = readPreview({
      ok: true,
      handle: "h",
      lines: Array.from({ length: 500 }, () => "y".repeat(5_000)),
      total: 500,
      complete: false,
    });
    expect(typeof long !== "string" && long.lines).toHaveLength(200);
    expect(typeof long !== "string" && long.lines[0]).toHaveLength(2_000);
    expect(readPreview({ ok: false, error: 'No stash entry named "x" on this branch.' })).toBe(
      'No stash entry named "x" on this branch.',
    );
    expect(readPreview(undefined)).toBe("pi-stash did not answer; is it loaded?");
    expect(readPreview({ ok: true, lines: "nope" })).toBe("pi-stash sent an unreadable preview.");
  });
});

describe("readGit", () => {
  const worktree = (overrides: Record<string, unknown> = {}) => ({
    path: "/w/api/feat-login",
    repo: "/src/api",
    branch: "feat/login",
    base: { ref: "main", sha: "a" },
    agents: [],
    state: "active",
    ...overrides,
  });
  const pr = (overrides: Record<string, unknown> = {}) => ({
    key: "github.com/acme/api#12",
    host: "github.com",
    owner: "acme",
    repo: "api",
    number: 12,
    url: "https://github.com/acme/api/pull/12",
    origin: "created",
    calls: [],
    ...overrides,
  });

  it("keeps live worktrees and counts removed and other ones", () => {
    const result = readGit({
      version: 1,
      worktrees: [
        worktree({
          status: { dirty: false, detached: 0, unpushed: 0, merged: true },
          workspace: "auth",
        }),
        worktree({ path: "/w/gone", state: "missing" }),
        worktree({ path: "/w/old", state: "removed" }),
      ],
      found: [{ path: "/w/x", repo: "/src/web" }],
      prs: [],
    });
    expect(result).toEqual({
      worktrees: [
        {
          path: "/w/api/feat-login",
          repo: "api",
          branch: "feat/login",
          workspace: "auth",
          state: "active",
          agents: 0,
          dirty: false,
          mergedInto: "main",
        },
        { path: "/w/gone", repo: "api", branch: "feat/login", state: "missing", agents: 0 },
      ],
      worktreeTotal: 2,
      removed: 1,
      other: 1,
      prs: [],
      prTotal: 0,
    });
  });

  it("maps pull request status and drops anything that could not be a safe PR link", () => {
    const result = readGit({
      version: 1,
      worktrees: [],
      found: [],
      prs: [
        pr({
          title: "Add\u001b[2J login",
          status: {
            state: "open",
            draft: true,
            review: "approved",
            checks: { passed: 3, failed: 1, pending: 0 },
            mergeable: false,
            observedAt: 9,
            source: "bash",
          },
        }),
        pr({ url: "javascript:alert(1)//github.com/a/b/pull/1" }),
        pr({ url: "http://github.com/acme/api/pull/12" }),
        pr({ url: 'https://github.com/acme/api/pull/12#x" onclick=' }),
        pr({ origin: "elsewhere" }),
        pr({
          status: { state: "weird", review: "lgtm", observedAt: 1, source: "bash" },
          number: 13,
          url: "https://github.com/acme/api/pull/13",
        }),
      ],
    });
    expect(result?.prs).toEqual([
      {
        label: "acme/api#12",
        url: "https://github.com/acme/api/pull/12",
        title: "Add [2J login",
        origin: "created",
        state: "open",
        draft: true,
        review: "approved",
        checks: { passed: 3, failed: 1, pending: 0 },
        mergeable: false,
        observedAt: 9,
      },
      {
        label: "acme/api#13",
        url: "https://github.com/acme/api/pull/13",
        origin: "created",
        observedAt: 1,
      },
    ]);
    expect(result?.prTotal).toBe(6);
  });

  it("caps long lists and is absent when there is nothing to show or the shape is wrong", () => {
    const many = readGit({
      version: 1,
      worktrees: Array.from({ length: 60 }, (_, i) => worktree({ path: `/w/${i}` })),
      found: [],
      prs: Array.from({ length: 60 }, (_, i) =>
        pr({ number: i + 1, url: `https://github.com/acme/api/pull/${i + 1}` }),
      ),
    });
    expect(many?.worktrees).toHaveLength(50);
    expect(many?.worktreeTotal).toBe(60);
    expect(many?.prs).toHaveLength(50);
    expect(many?.prTotal).toBe(60);
    expect(readGit({ version: 1, worktrees: [], found: [], prs: [] })).toBeUndefined();
    expect(readGit({ version: 2, worktrees: [worktree()] })).toBeUndefined();
    expect(readGit(null)).toBeUndefined();
    // A snapshot from a pi-git without pull requests still reads.
    expect(readGit({ version: 1, worktrees: [worktree()], found: [] })?.prTotal).toBe(0);
  });
});
