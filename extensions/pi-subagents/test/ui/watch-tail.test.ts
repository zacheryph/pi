import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "#src/types";
import { WatchTail, watchText } from "#src/ui/watch-tail";

// Only content fields are used; keep streaming fixtures independent from model metadata.
function assistant(type: "message_start" | "message_update" | "message_end", text: string): AgentSessionEvent {
  return { type, message: { role: "assistant", content: [{ type: "text", text }] } } as AgentSessionEvent;
}

describe("WatchTail", () => {
  it("updates one assistant block while streaming and keeps subsequent messages separate", () => {
    const tail = new WatchTail();
    tail.apply(assistant("message_start", ""));
    tail.apply(assistant("message_update", "Found"));
    tail.apply(assistant("message_update", "Found auth middleware"));
    expect(tail.blocks).toEqual(["Found auth middleware"]);
    tail.apply(assistant("message_end", "Found auth middleware."));
    tail.apply(assistant("message_start", ""));
    tail.apply(assistant("message_update", "Adding tests"));
    expect(tail.blocks).toEqual(["Found auth middleware.", "Adding tests"]);
  });

  it("does not expose user prompts or thinking content", () => {
    const tail = new WatchTail();
    tail.apply({ type: "message_end", message: { role: "user", content: "private prompt", timestamp: 1 } });
    tail.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }] } } as AgentSessionEvent);
    expect(tail.blocks).toEqual([]);
  });

  it("summarizes a tool call and updates result in place instead of dumping payload", () => {
    const tail = new WatchTail();
    tail.apply({ type: "tool_execution_start", toolCallId: "r", toolName: "read", args: { path: "src/auth.ts", content: "Huge payload" } });
    expect(tail.blocks).toEqual(["› read src/auth.ts …"]);
    tail.apply({ type: "tool_execution_update", toolCallId: "r", toolName: "read", args: {}, partialResult: { content: [{ type: "text", text: "first line\nlast line" }] } });
    expect(tail.blocks).toEqual(["… read src/auth.ts — last line"]);
    tail.apply({ type: "tool_execution_end", toolCallId: "r", toolName: "read", result: { content: [{ type: "text", text: "Failed" }] }, isError: true });
    expect(tail.blocks).toEqual(["✗ read src/auth.ts — Failed"]);
  });

  it("tracks parallel and nested calls separately", () => {
    const tail = new WatchTail();
    for (const toolCallId of ["a", "a/1", "b"]) {
      tail.apply({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: toolCallId } });
    }
    tail.apply({ type: "tool_execution_end", toolCallId: "a/1", toolName: "bash", result: null, isError: false });
    expect(tail.blocks).toEqual(["› bash a …", "✓ bash a/1", "› bash b …"]);
  });

  it("reports compaction and retries, ignoring unrelated session events", () => {
    const tail = new WatchTail();
    expect(tail.apply({ type: "agent_start" })).toBe(false);
    tail.apply({ type: "compaction_start", reason: "threshold" });
    tail.apply({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 100, errorMessage: "network" });
    expect(tail.blocks).toEqual(["Compacting context…", "Retry 2/3"]);
  });

  it("bounds stored entries/text and reports duplicate updates as unchanged", () => {
    const tail = new WatchTail();
    for (let i = 0; i < 100; i++) tail.note(`note ${i}`);
    expect(tail.blocks).toHaveLength(32);
    expect(tail.blocks[0]).toBe("note 68");
    tail.apply(assistant("message_start", ""));
    expect(tail.apply(assistant("message_update", "x".repeat(20_000)))).toBe(true);
    expect(tail.blocks.at(-1)).toHaveLength(4096);
    expect(tail.apply(assistant("message_update", "x".repeat(20_000)))).toBe(false);
  });

  it("strips ANSI colors, OSC hyperlinks, and cursor/control sequences", () => {
    expect(watchText("\x1b[31mred\x1b[0m\x1b[2J\x1b]8;;https://bad\x07link\x1b]8;;\x07\nnext\x00\r")).toBe("redlink\nnext");
  });
});
