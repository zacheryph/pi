import { describe, expect, it } from "vitest";
import { clip, readPreview, readStash, readTodoHistory, readTodos } from "#src/sections";

const task = (overrides: Record<string, unknown> = {}) => ({
  key: "a", subject: "Add retry backoff", status: "in_progress", blocked: false, unreviewed: 0, updates: [], ...overrides,
});

const entry = (overrides: Record<string, unknown> = {}) => ({
  handle: "stash:notes@0123456789ab", name: "notes", hash: "0".repeat(64), bytes: 10, lines: 2, mime: "text/plain",
  createdAt: 1_700_000_000_000, createdBy: "session-a", source: "content", versions: 1, ...overrides,
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
    const result = readTodos({ version: 1, revision: 4, tasks: [
      task({ description: "cap at 8s", dependsOn: ["root"], createdAt: 10, unreviewed: 2, updates: [
        { revision: 2, at: 20, status: "in_progress", message: "started" },
        { revision: 3, at: 30, status: "in_progress", message: "jitter added" },
        { revision: 4, at: 40, status: "in_progress" },
      ] }),
      task({ key: "b", subject: "Write test", status: "pending", blocked: true }),
    ] });
    expect(result).toEqual({ revision: 4, total: 2, tasks: [
      { key: "a", subject: "Add retry backoff", status: "in_progress", blocked: false, unreviewed: 2, description: "cap at 8s",
        dependsOn: ["root"], message: { text: "jitter added", at: 30 }, updatedAt: 40 },
      { key: "b", subject: "Write test", status: "pending", blocked: true, unreviewed: 0 },
    ] });
  });

  it("drops malformed tasks and rejects unknown payload versions", () => {
    expect(readTodos({ version: 1, revision: 1, tasks: [task({ status: "done" }), task({ key: "" }), null, task()] })?.tasks).toHaveLength(1);
    expect(readTodos({ version: 2, revision: 1, tasks: [] })).toBeUndefined();
    expect(readTodos({ version: 1 })).toBeUndefined();
    expect(readTodos("nope")).toBeUndefined();
  });

  it("caps long text and the number of tasks", () => {
    const tasks = Array.from({ length: 150 }, (_, index) => task({ key: `t${index}`, description: "d".repeat(2_000) }));
    const result = readTodos({ version: 1, revision: 1, tasks })!;
    expect(result.total).toBe(150);
    expect(result.tasks).toHaveLength(100);
    expect(result.tasks[0]?.description).toHaveLength(500);
  });
});

describe("readStash", () => {
  it("keeps entry metadata in order", () => {
    expect(readStash({ version: 1, entries: [entry({ description: "auth audit" }), entry({ name: "log", source: "tool:bash", versions: 3 })] })).toEqual({
      total: 2,
      entries: [
        { name: "notes", handle: "stash:notes@0123456789ab", bytes: 10, lines: 2, mime: "text/plain", source: "content",
          createdAt: 1_700_000_000_000, createdBy: "session-a", versions: 1, description: "auth audit" },
        { name: "log", handle: "stash:notes@0123456789ab", bytes: 10, lines: 2, mime: "text/plain", source: "tool:bash",
          createdAt: 1_700_000_000_000, createdBy: "session-a", versions: 3 },
      ],
    });
  });

  it("drops malformed entries, never carries content, and rejects unknown versions", () => {
    const result = readStash({ version: 1, entries: [entry({ bytes: -1 }), entry({ name: 5 }), entry({ content: "secret" })] });
    expect(result?.entries).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(readStash({ version: 3, entries: [] })).toBeUndefined();
  });
});

describe("readStash store size", () => {
  it("passes the store size and cap through, and drops malformed ones", () => {
    expect(readStash({ version: 1, entries: [], store: { bytes: 5, maxBytes: 10 } })?.store).toEqual({ bytes: 5, maxBytes: 10 });
    expect(readStash({ version: 1, entries: [], store: { bytes: -1, maxBytes: 10 } })?.store).toBeUndefined();
    expect(readStash({ version: 1, entries: [] })?.store).toBeUndefined();
  });
});

describe("readTodoHistory", () => {
  const event = { version: 1, revision: 3, tasks: [task({ key: "a", createdAt: 5, updates: [
    { revision: 1, at: 10, status: "in_progress", from: "pending", by: "user" },
    { revision: 2, at: 20, status: "completed", from: "in_progress", message: "x".repeat(3_000) },
    { revision: 3, at: 0, status: "completed" },
    { revision: 4, at: 30, status: "done" },
  ] })] };

  it("returns one task's history with validated updates", () => {
    const history = readTodoHistory(event, "a")!;
    expect(history.createdAt).toBe(5);
    expect(history.updates).toHaveLength(2);
    expect(history.updates[0]).toEqual({ revision: 1, at: 10, status: "in_progress", from: "pending", byUser: true });
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
    expect(readPreview({ ok: true, handle: "stash:a@0123456789ab", lines: ["one", 2, "three"], total: 9, complete: false }))
      .toEqual({ handle: "stash:a@0123456789ab", lines: ["one", "", "three"], total: 9, complete: false });
    const long = readPreview({ ok: true, handle: "h", lines: Array.from({ length: 500 }, () => "y".repeat(5_000)), total: 500, complete: false });
    expect(typeof long !== "string" && long.lines).toHaveLength(200);
    expect(typeof long !== "string" && long.lines[0]).toHaveLength(2_000);
    expect(readPreview({ ok: false, error: "No stash entry named \"x\" on this branch." })).toBe("No stash entry named \"x\" on this branch.");
    expect(readPreview(undefined)).toBe("pi-stash did not answer; is it loaded?");
    expect(readPreview({ ok: true, lines: "nope" })).toBe("pi-stash sent an unreadable preview.");
  });
});
