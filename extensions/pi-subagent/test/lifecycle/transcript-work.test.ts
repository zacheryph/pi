import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, onTestFinished } from "vitest";
import { transcriptWork } from "#src/lifecycle/transcript-work";
import { tempDir } from "../../../../packages/pi-test-helpers/src/temp.ts";
import { WORK_ENTRY, WORK_LOST } from "../../../../packages/pi-work/src/index.ts";

// The work an agent's transcript holds open, read and settled with no live session, on a real
// session file and Pi's own session manager.

function transcript() {
  const dir = tempDir(onTestFinished, "transcript-work-");
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    api: "faux",
    provider: "faux",
    model: "m",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  const open = (id: string, kind: string, label: string) =>
    manager.appendCustomEntry(WORK_ENTRY, {
      v: 1,
      op: "open",
      id,
      owner: "pi-job",
      kind,
      label,
      at: 5,
    });
  const close = (id: string) =>
    manager.appendCustomEntry(WORK_ENTRY, { v: 1, op: "close", id, reason: "completed", at: 6 });
  return { path: manager.getSessionFile()!, open, close, dir };
}

const work = transcriptWork((path) => SessionManager.open(path));

describe("transcriptWork", () => {
  it("reads the items opened and not yet closed, oldest first", () => {
    const t = transcript();
    t.open("a", "watch", "CI");
    t.open("b", "job", "build");
    t.close("a");
    t.open("c", "question", "answer");
    expect(work.openItems(t.path).map((item) => [item.id, item.kind, item.label])).toEqual([
      ["b", "job", "build"],
      ["c", "question", "answer"],
    ]);
  });

  it("reads nothing from a transcript that is missing, unreadable or holds nothing open", () => {
    const t = transcript();
    expect(work.openItems(t.path)).toEqual([]);
    expect(work.openItems(join(t.dir, "missing.jsonl"))).toEqual([]);
  });

  it("closes the items as lost and writes the lost message, with no live session", () => {
    const t = transcript();
    t.open("a", "watch", "CI");
    t.open("b", "job", "build");
    const items = work.openItems(t.path);
    expect(work.closeLost(t.path, items)).toBe(true);

    // The next reader finds nothing open, and the message is in the conversation for the next run.
    expect(work.openItems(t.path)).toEqual([]);
    const lines = readFileSync(t.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const closes = lines.filter((entry) => entry.type === "custom" && entry.data?.op === "close");
    expect(closes.map((entry) => [entry.data.id, entry.data.reason])).toEqual([
      ["a", "lost"],
      ["b", "lost"],
    ]);
    const message = lines.find((entry) => entry.type === "custom_message");
    expect(message).toMatchObject({ customType: WORK_LOST, display: true });
    expect(message.content).toContain("Work lost: 2 items");
    expect(message.content).toContain('watch "CI"');
    expect(message.details.items.map((item: { id: string }) => item.id)).toEqual(["a", "b"]);
  });

  it("writes nothing for no items, and survives a transcript it cannot open", () => {
    const t = transcript();
    expect(work.closeLost(t.path, [])).toBe(false);
    expect(readFileSync(t.path, "utf8")).not.toContain(WORK_LOST);
    const broken = transcriptWork(() => {
      throw new Error("not a session file");
    });
    const item = { id: "a", owner: "o", kind: "k", label: "l", openedAt: 1 };
    expect(broken.openItems(t.path)).toEqual([]);
    expect(broken.closeLost(t.path, [item])).toBe(false);
  });
});
