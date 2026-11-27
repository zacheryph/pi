import { describe, expect, it, vi } from "vitest";
import { SubagentState } from "#src/lifecycle/subagent-state";
import { subscribeSubagentObserver } from "#src/observation/record-observer";
import { createMockSession } from "#test/helpers/mock-session";

function makeState() {
  return new SubagentState({ status: "running" });
}

describe("subscribeSubagentObserver", () => {
  it("increments state.toolUses on tool_execution_end", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    expect(state.toolUses).toBe(0);
    session.emit({ type: "tool_execution_end", toolName: "Read" });
    expect(state.toolUses).toBe(1);
    session.emit({ type: "tool_execution_end", toolName: "Write" });
    expect(state.toolUses).toBe(2);
  });

  it("accumulates lifetimeUsage on message_end with assistant usage", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({
      type: "message_end",
      message: { role: "assistant", usage: { input: 100, output: 50, cacheWrite: 10 } },
    });
    expect(state.lifetimeUsage).toEqual({ input: 100, output: 50, cacheWrite: 10 });

    session.emit({
      type: "message_end",
      message: { role: "assistant", usage: { input: 200, output: 80, cacheWrite: 20 } },
    });
    expect(state.lifetimeUsage).toEqual({ input: 300, output: 130, cacheWrite: 30 });
  });

  it("ignores message_end from non-assistant roles", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({
      type: "message_end",
      message: { role: "user", usage: { input: 999, output: 999, cacheWrite: 999 } },
    });
    expect(state.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
  });

  it("increments compactionCount on compaction_end (not aborted)", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({
      type: "compaction_end",
      aborted: false,
      result: { tokensBefore: 12345 },
      reason: "threshold",
    });
    expect(state.compactionCount).toBe(1);

    session.emit({
      type: "compaction_end",
      aborted: false,
      result: { tokensBefore: 22222 },
      reason: "manual",
    });
    expect(state.compactionCount).toBe(2);
  });

  it("calls onCompact with info on compaction_end", () => {
    const session = createMockSession();
    const state = makeState();
    const onCompact = vi.fn();
    subscribeSubagentObserver(session, state, { onCompact });

    session.emit({
      type: "compaction_end",
      aborted: false,
      result: { tokensBefore: 12345 },
      reason: "threshold",
    });

    expect(onCompact).toHaveBeenCalledWith({
      reason: "threshold",
      tokensBefore: 12345,
    });
  });

  it("ignores compaction_end with aborted: true", () => {
    const session = createMockSession();
    const state = makeState();
    const onCompact = vi.fn();
    subscribeSubagentObserver(session, state, { onCompact });

    session.emit({
      type: "compaction_end",
      aborted: true,
      result: { tokensBefore: 5000 },
      reason: "overflow",
    });
    expect(state.compactionCount).toBe(0);
    expect(onCompact).not.toHaveBeenCalled();
  });

  it("ignores compaction_end without result", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({
      type: "compaction_end",
      aborted: false,
      reason: "threshold",
    });
    expect(state.compactionCount).toBe(0);
  });

  it("adds to activeTools on tool_execution_start", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({ type: "tool_execution_start", toolName: "Read" });
    expect(state.activeTools.size).toBe(1);
    expect([...state.activeTools.values()]).toContain("Read");
  });

  it("removes from activeTools on tool_execution_end (paired with start)", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({ type: "tool_execution_start", toolName: "Read" });
    session.emit({ type: "tool_execution_end", toolName: "Read" });
    expect(state.activeTools.size).toBe(0);
  });

  it("leaves the turn budget to the turn loop on turn_end", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({ type: "turn_end" });
    expect(state.turnBudget).toBeUndefined();
  });

  it("resets responseText on message_start", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "previous text" },
    });
    session.emit({ type: "message_start" });
    expect(state.responseText).toBe("");
  });

  it("appends to responseText on message_update text_delta", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello " },
    });
    expect(state.responseText).toBe("Hello ");

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "world" },
    });
    expect(state.responseText).toBe("Hello world");
  });

  it("ignores message_update with non-text_delta events", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "pondering..." },
    });
    expect(state.responseText).toBe("");
  });

  it("returned function unsubscribes from session", () => {
    const session = createMockSession();
    const state = makeState();
    const unsubscribe = subscribeSubagentObserver(session, state);

    session.emit({ type: "tool_execution_end", toolName: "Read" });
    expect(state.toolUses).toBe(1);

    unsubscribe();

    session.emit({ type: "tool_execution_end", toolName: "Write" });
    expect(state.toolUses).toBe(1); // unchanged
  });

  // Activity change callback tests: verify callback sees state changes
  it("calls onActivityChange on tool_execution_start and callback sees activeTools updated", () => {
    const session = createMockSession();
    const state = makeState();
    const capturedStates: Array<{ activeTools: number }> = [];
    const onActivityChange = vi.fn(() => {
      capturedStates.push({ activeTools: state.activeTools.size });
    });
    subscribeSubagentObserver(session, state, { onActivityChange });

    session.emit({ type: "tool_execution_start", toolName: "Read" });
    expect(onActivityChange).toHaveBeenCalledOnce();
    expect(capturedStates).toEqual([{ activeTools: 1 }]);
    expect([...state.activeTools.values()]).toContain("Read");
  });

  it("calls onActivityChange on tool_execution_end and callback sees activeTools removed and toolUses incremented", () => {
    const session = createMockSession();
    const state = makeState();
    const capturedStates: Array<{ activeTools: number; toolUses: number }> = [];
    const onActivityChange = vi.fn(() => {
      capturedStates.push({ activeTools: state.activeTools.size, toolUses: state.toolUses });
    });
    subscribeSubagentObserver(session, state, { onActivityChange });

    session.emit({ type: "tool_execution_start", toolName: "Read" });
    expect(state.activeTools.size).toBe(1);
    session.emit({ type: "tool_execution_end", toolName: "Read" });
    expect(onActivityChange).toHaveBeenCalledTimes(2);
    expect(capturedStates[1]).toEqual({ activeTools: 0, toolUses: 1 });
  });

  it("calls onActivityChange on message_start only when responseText was nonempty (visible change, no spurious announcements)", () => {
    const session = createMockSession();
    const state = makeState();
    const onActivityChange = vi.fn();
    subscribeSubagentObserver(session, state, { onActivityChange });

    // First message_start: responseText is empty → empty, no announcement (no visible change)
    session.emit({ type: "message_start" });
    expect(onActivityChange).not.toHaveBeenCalled();
    expect(state.responseText).toBe("");

    // Add text
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    });
    expect(onActivityChange).toHaveBeenCalledTimes(1); // first text
    expect(state.responseText).toBe("Hello");

    // Second message_start: responseText was nonempty → empty, announce (visible change)
    session.emit({ type: "message_start" });
    expect(onActivityChange).toHaveBeenCalledTimes(2);
    expect(state.responseText).toBe("");
  });

  it("announces each nonempty text_delta after updating the visible response text", () => {
    const session = createMockSession();
    const state = makeState();
    const capturedTexts: string[] = [];
    const onActivityChange = vi.fn(() => {
      capturedTexts.push(state.responseText);
    });
    subscribeSubagentObserver(session, state, { onActivityChange });

    // Start a message (no announcement since responseText is empty)
    session.emit({ type: "message_start" });
    expect(onActivityChange).not.toHaveBeenCalled();

    // Empty delta should not trigger
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "" },
    });
    expect(onActivityChange).not.toHaveBeenCalled();

    // First nonempty delta should trigger and capture text
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    });
    expect(onActivityChange).toHaveBeenCalledOnce();
    expect(capturedTexts).toEqual(["Hello"]);

    onActivityChange.mockClear();
    capturedTexts.length = 0;

    // Subsequent deltas change the text the widget shows too.
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: " world" },
    });
    expect(onActivityChange).toHaveBeenCalledOnce();
    expect(capturedTexts).toEqual(["Hello world"]);
    expect(state.responseText).toBe("Hello world");
  });

  it("announces text resets and the text of a subsequent message", () => {
    const session = createMockSession();
    const state = makeState();
    const onActivityChange = vi.fn();
    subscribeSubagentObserver(session, state, { onActivityChange });

    // First message: start (no announce, empty), text (announce)
    session.emit({ type: "message_start" });
    expect(onActivityChange).not.toHaveBeenCalled();
    onActivityChange.mockClear();
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "First" },
    });
    expect(onActivityChange).toHaveBeenCalledOnce();

    // Second message: both clearing the prior text and adding new text are visible.
    onActivityChange.mockClear();
    session.emit({ type: "message_start" });
    expect(onActivityChange).toHaveBeenCalledOnce();
    expect(state.responseText).toBe("");

    onActivityChange.mockClear();
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Second" },
    });
    expect(onActivityChange).toHaveBeenCalledOnce();
  });

  it("calls onActivityChange on message_end with assistant usage and callback sees usage updated", () => {
    const session = createMockSession();
    const state = makeState();
    const capturedStates: Array<{ input: number; output: number; cacheWrite: number }> = [];
    const onActivityChange = vi.fn(() => {
      capturedStates.push({ ...state.lifetimeUsage });
    });
    subscribeSubagentObserver(session, state, { onActivityChange });

    session.emit({
      type: "message_end",
      message: { role: "assistant", usage: { input: 100, output: 50, cacheWrite: 10 } },
    });
    expect(onActivityChange).toHaveBeenCalledOnce();
    expect(capturedStates).toEqual([{ input: 100, output: 50, cacheWrite: 10 }]);
    expect(state.lifetimeUsage).toEqual({ input: 100, output: 50, cacheWrite: 10 });
  });

  it("does not call onActivityChange on message_end from non-assistant (state unchanged)", () => {
    const session = createMockSession();
    const state = makeState();
    const onActivityChange = vi.fn();
    const initialUsage = { ...state.lifetimeUsage };
    subscribeSubagentObserver(session, state, { onActivityChange });

    session.emit({
      type: "message_end",
      message: { role: "user", usage: { input: 100, output: 50, cacheWrite: 10 } },
    });
    expect(onActivityChange).not.toHaveBeenCalled();
    expect(state.lifetimeUsage).toEqual(initialUsage);
  });

  it("does not call onActivityChange on compaction_end (only persists via onCompact)", () => {
    const session = createMockSession();
    const state = makeState();
    const onActivityChange = vi.fn();
    const onCompact = vi.fn();
    subscribeSubagentObserver(session, state, { onActivityChange, onCompact });

    session.emit({
      type: "compaction_end",
      aborted: false,
      result: { tokensBefore: 5000 },
      reason: "threshold",
    });
    expect(onActivityChange).not.toHaveBeenCalled();
    expect(state.compactionCount).toBe(1);
    expect(onCompact).toHaveBeenCalledOnce();
  });

  it("unsubscribe stops all callbacks (no stale updates after unsubscribe)", () => {
    const session = createMockSession();
    const state = makeState();
    const onActivityChange = vi.fn();
    const unsubscribe = subscribeSubagentObserver(session, state, { onActivityChange });

    session.emit({ type: "tool_execution_start", toolName: "Test" });
    expect(onActivityChange).toHaveBeenCalledOnce();

    unsubscribe();
    session.emit({ type: "tool_execution_end", toolName: "Test" });
    expect(onActivityChange).toHaveBeenCalledTimes(1); // unchanged
  });

  it("multiple tools tracked separately: start/end each triggers activity change", () => {
    const session = createMockSession();
    const state = makeState();
    const onActivityChange = vi.fn();
    subscribeSubagentObserver(session, state, { onActivityChange });

    session.emit({ type: "tool_execution_start", toolName: "Read" });
    session.emit({ type: "tool_execution_start", toolName: "Write" });
    expect(onActivityChange).toHaveBeenCalledTimes(2);
    expect(state.activeTools.size).toBe(2);

    session.emit({ type: "tool_execution_end", toolName: "Read" });
    expect(state.activeTools.size).toBe(1);
    expect(state.toolUses).toBe(1);
    expect(onActivityChange).toHaveBeenCalledTimes(3);

    session.emit({ type: "tool_execution_end", toolName: "Write" });
    expect(state.activeTools.size).toBe(0);
    expect(state.toolUses).toBe(2);
    expect(onActivityChange).toHaveBeenCalledTimes(4);
  });

  it("activity changes preserve run lifetime across multiple messages (cumulative usage)", () => {
    const session = createMockSession();
    const state = makeState();
    const onActivityChange = vi.fn();
    subscribeSubagentObserver(session, state, { onActivityChange });

    // First message: start (no announce, empty), text (announce), end (announce, usage)
    session.emit({ type: "message_start" });
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Text1" },
    });
    session.emit({
      type: "message_end",
      message: { role: "assistant", usage: { input: 50, output: 25, cacheWrite: 5 } },
    });
    expect(state.lifetimeUsage).toEqual({ input: 50, output: 25, cacheWrite: 5 });
    expect(onActivityChange).toHaveBeenCalledTimes(2); // first text + message end
    expect(state.responseText).toBe("Text1"); // text persists after message_end

    onActivityChange.mockClear();

    // Second message: message_start sees nonempty text from previous message, so announces
    session.emit({ type: "message_start" }); // nonempty->empty, announce
    expect(onActivityChange).toHaveBeenCalledOnce();
    expect(state.responseText).toBe("");

    onActivityChange.mockClear();
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Text2" },
    });
    session.emit({
      type: "message_end",
      message: { role: "assistant", usage: { input: 100, output: 50, cacheWrite: 10 } },
    });
    expect(state.lifetimeUsage).toEqual({ input: 150, output: 75, cacheWrite: 15 });
    expect(onActivityChange).toHaveBeenCalledTimes(2); // first text + message end
  });
});
