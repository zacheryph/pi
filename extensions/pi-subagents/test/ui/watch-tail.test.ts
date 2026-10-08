import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "#src/types";
import { WatchTail, watchText } from "#src/ui/watch-tail";

// Only content fields are used; keep streaming fixtures independent from model metadata.
function assistant(type: "message_start" | "message_update" | "message_end", text: string): AgentSessionEvent {
  return { type, message: { role: "assistant", content: [{ type: "text", text }] } } as AgentSessionEvent;
}
function thinking(type: "message_update" | "message_end", text: string): AgentSessionEvent {
  return { type, message: { role: "assistant", content: [{ type: "thinking", thinking: text }] } } as AgentSessionEvent;
}
const texts = (tail: WatchTail) => tail.blocks.map(block => block.text);
function skillTail() {
  return new WatchTail({ cwd: "/project", skills: [{ name: "deploy", filePath: "/project/skills/deploy/SKILL.md" }] });
}
function start(tail: WatchTail, path = "skills/deploy/SKILL.md", id = "read", extra = {}) {
  return tail.apply({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path, ...extra } });
}
function end(tail: WatchTail, id = "read", isError = false) {
  return tail.apply({ type: "tool_execution_end", toolCallId: id, toolName: "read", result: { content: [{ type: "text", text: "secret skill contents" }] }, isError });
}

describe("WatchTail", () => {
  it("updates one assistant block while streaming and keeps subsequent messages separate", () => {
    const tail = new WatchTail();
    tail.apply(assistant("message_start", ""));
    tail.apply(assistant("message_update", "Found"));
    tail.apply(assistant("message_update", "Found auth middleware"));
    expect(tail.blocks).toEqual([{ kind: "text", text: "Found auth middleware" }]);
    tail.apply(assistant("message_end", "Found auth middleware."));
    tail.apply(assistant("message_start", ""));
    tail.apply(assistant("message_update", "Adding tests"));
    expect(texts(tail)).toEqual(["Found auth middleware.", "Adding tests"]);
  });

  it("ignores prompts, transcript results, tool-call payloads and unrelated events", () => {
    const tail = new WatchTail();
    tail.apply({ type: "message_end", message: { role: "user", content: "private prompt", timestamp: 1 } });
    tail.apply({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "inherited read" }] } } as AgentSessionEvent);
    tail.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "toolCall", arguments: { secret: "payload" } }] } } as unknown as AgentSessionEvent);
    expect(tail.apply({ type: "agent_start" })).toBe(false);
    expect(tail.blocks).toEqual([]);
  });

  it("retains provider-emitted thinking, filters reversibly, and never invents reasoning", () => {
    const tail = new WatchTail();
    tail.apply(assistant("message_start", ""));
    expect(tail.blocks).toEqual([]);
    tail.apply(thinking("message_update", "Review"));
    tail.apply(thinking("message_update", "Review auth"));
    expect(tail.visibleBlocks(false)).toEqual([]);
    expect(tail.visibleBlocks()).toEqual([{ kind: "thinking", text: "Review auth" }]);
    tail.apply({ type: "message_end", message: { role: "assistant", content: [
      { type: "thinking", thinking: "Review auth" }, { type: "text", text: "Fixed" },
      { type: "thinking", thinking: "Check tests" }, { type: "text", text: "Tests pass" },
    ] } } as AgentSessionEvent);
    expect(tail.blocks.map(block => block.kind)).toEqual(["thinking", "text", "thinking", "text"]);
    expect(tail.visibleBlocks(false).map(block => block.text)).toEqual(["Fixed", "Tests pass"]);
    expect(tail.visibleBlocks(true)).toHaveLength(4);
  });

  it("removes empty/redacted streamed thinking rather than leaving stale text", () => {
    const tail = new WatchTail();
    tail.apply(thinking("message_update", "reason"));
    expect(tail.apply(thinking("message_end", ""))).toBe(true);
    expect(tail.blocks).toEqual([]);
  });

  it("represents provider errors distinctly", () => {
    const tail = new WatchTail();
    tail.apply({ type: "message_end", message: { role: "assistant", content: [], errorMessage: "Provider failed\x1b[2J" } } as unknown as AgentSessionEvent);
    expect(tail.blocks).toEqual([{ kind: "error", text: "Provider failed" }]);
  });

  it("summarizes a tool call and updates result in place instead of dumping payload", () => {
    const tail = new WatchTail();
    tail.apply({ type: "tool_execution_start", toolCallId: "r", toolName: "read", args: { path: "src/auth.ts", content: "Huge payload" } });
    expect(tail.blocks).toEqual([{ kind: "tool", text: "… read src/auth.ts", status: "pending" }]);
    tail.apply({ type: "tool_execution_update", toolCallId: "r", toolName: "read", args: {}, partialResult: { content: [{ type: "text", text: "first line\nlast line" }] } });
    expect(texts(tail)).toEqual(["… read src/auth.ts — last line"]);
    tail.apply({ type: "tool_execution_end", toolCallId: "r", toolName: "read", result: { content: [{ type: "text", text: "Failed" }] }, isError: true });
    expect(tail.blocks).toEqual([{ kind: "tool", text: "✗ read src/auth.ts — Failed", status: "error" }]);
  });

  it("tracks parallel and nested calls separately", () => {
    const tail = new WatchTail();
    for (const toolCallId of ["a", "a/1", "b"]) {
      tail.apply({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: toolCallId } });
    }
    tail.apply({ type: "tool_execution_end", toolCallId: "a/1", toolName: "bash", result: null, isError: false });
    expect(texts(tail)).toEqual(["… bash a", "✓ bash a/1", "… bash b"]);
  });

  it("reports compaction and retries", () => {
    const tail = new WatchTail();
    tail.apply({ type: "compaction_start", reason: "threshold" });
    tail.apply({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 100, errorMessage: "network" });
    expect(texts(tail)).toEqual(["Compacting context…", "Retry 2/3"]);
  });

  it("bounds stored entries/text and reports duplicate updates as unchanged", () => {
    const tail = new WatchTail();
    for (let i = 0; i < 100; i++) tail.note(`note ${i}`);
    expect(tail.blocks).toHaveLength(32);
    expect(tail.blocks[0].text).toBe("note 68");
    tail.apply(assistant("message_start", ""));
    expect(tail.apply(assistant("message_update", "x".repeat(20_000)))).toBe(true);
    expect(tail.blocks.at(-1)?.text).toHaveLength(4096);
    expect(tail.apply(assistant("message_update", "x".repeat(20_000)))).toBe(false);
  });

  it("bounds hidden thinking together with other entries", () => {
    const tail = new WatchTail();
    for (let i = 0; i < 100; i++) tail.apply(thinking("message_end", `${i}: ${"x".repeat(5000)}`));
    expect(tail.blocks).toHaveLength(32);
    expect(tail.blocks.every(block => block.text.length <= 4096)).toBe(true);
    expect(tail.visibleBlocks(false)).toEqual([]);
    expect(tail.visibleBlocks(true)).toHaveLength(32);
  });

  it("strips ANSI, OSC, DCS, C1, cursor markers, incomplete escapes and bidi controls", () => {
    expect(watchText("\x1b[31mred\x1b[0m\x1b[2J\x1b]8;;https://bad\x07link\x1b]8;;\x07\nnext\x00\r")).toBe("redlink\nnext");
    expect(watchText("ok\x1bPsecret\x1b\\\u009b2J\u009d8;;hidden\u009c\u202efine\x1b_pi:cursor\x07")).toBe("okfine");
    expect(watchText("ok\x1b]unterminated\nprivate")).toBe("ok");
    expect(watchText("ok\x1b[31")).toBe("ok");
  });
});

describe("WatchTail skill evidence", () => {
  it("shows pending and then loaded only after a successful known SKILL.md read", () => {
    const tail = skillTail();
    start(tail);
    expect(tail.blocks).toEqual([{ kind: "skill", text: "deploy · loading…", status: "pending", partial: false }]);
    tail.apply({ type: "tool_execution_update", toolCallId: "read", toolName: "read", args: {}, partialResult: { content: [{ type: "text", text: "secret skill contents" }] } });
    expect(texts(tail)).toEqual(["deploy · loading…"]);
    end(tail);
    expect(tail.blocks).toEqual([{ kind: "skill", text: "deploy · loaded", status: "success", partial: false }]);
    expect(end(tail)).toBe(false);
    expect(JSON.stringify(tail.blocks)).not.toContain("secret");
  });

  it("does not mark failed known reads loaded", () => {
    const tail = skillTail();
    start(tail);
    end(tail, "read", true);
    expect(tail.blocks).toEqual([{ kind: "skill", text: "deploy · failed", status: "error", partial: false }]);
  });

  it.each([{ offset: 1 }, { limit: 2000 }, { offset: 2, limit: 10 }])("marks explicit partial reads without claiming full load: %j", extra => {
    const tail = skillTail();
    start(tail, undefined, undefined, extra);
    end(tail);
    expect(tail.blocks[0]).toEqual({ kind: "skill", text: "deploy · read · partial", status: "success", partial: true });
  });

  it("does not infer skill use from unknown paths, bash mentions, or results without matching starts", () => {
    const tail = skillTail();
    start(tail, "unknown/SKILL.md");
    end(tail);
    tail.apply({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "cat skills/deploy/SKILL.md" } });
    end(tail, "orphan");
    expect(tail.blocks.every(block => block.kind === "tool")).toBe(true);
  });

  it("counts successful nested reads even when their parent later fails", () => {
    const tail = skillTail();
    tail.apply({ type: "tool_execution_start", toolCallId: "p", toolName: "codemode", args: {} });
    tail.apply({ type: "tool_execution_start", toolCallId: "p/1/1", parentToolCallId: "p/1", toolName: "read", args: { path: "skills/deploy/SKILL.md" } });
    end(tail, "p/1/1");
    tail.apply({ type: "tool_execution_end", toolCallId: "p", toolName: "codemode", result: null, isError: true });
    expect(tail.blocks.map(block => [block.kind, block.status])).toEqual([["tool", "error"], ["skill", "success"]]);
    expect(texts(tail)).toContain("deploy · loaded");
  });

  it("matches relative, normalized and symlink paths without reading skill files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "watch-skill-"));
    try {
      mkdirSync(join(cwd, "skills"));
      symlinkSync(join(cwd, "skills"), join(cwd, "alias"));
      writeFileSync(join(cwd, "skills", "SKILL.md"), "private instructions");
      const tail = new WatchTail({ cwd, skills: [{ name: "known", filePath: join(cwd, "skills", "SKILL.md") }] });
      start(tail, "alias/../alias/SKILL.md");
      end(tail);
      expect(texts(tail)).toEqual(["known · loaded"]);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("evicts call metadata with the feed rather than accumulating completed calls", () => {
    const tail = skillTail();
    for (let i = 0; i < 100; i++) { start(tail, undefined, String(i)); end(tail, String(i)); }
    expect(tail.blocks).toHaveLength(32);
    end(tail, "0");
    expect(tail.blocks.at(-1)?.kind).toBe("tool"); // old matching start no longer retained
    expect(tail.blocks).toHaveLength(32);
  });
});
