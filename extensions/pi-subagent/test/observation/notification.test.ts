import { describe, expect, it, vi } from "vitest";
import {
  buildEventData,
  buildNotificationDetails,
  escapeXml,
  completionMessage,
  formatTaskNotification,
  formatUpdateNotification,
  updateMessage,
} from "#src/observation/notification";
import { createTestSubagent } from "#test/helpers/make-subagent";

// ---- Pure helper tests ----

describe("escapeXml", () => {
  it("escapes &, <, >", () => {
    expect(escapeXml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("returns unchanged string with no special chars", () => {
    expect(escapeXml("hello world")).toBe("hello world");
  });

  it("escapes double and single quotes (attribute-safe)", () => {
    expect(escapeXml('say "hi" it\'s fine')).toBe("say &quot;hi&quot; it&apos;s fine");
  });
});

describe("formatTaskNotification", () => {
  const baseRecord = createTestSubagent();

  it("produces valid XML structure", () => {
    const xml = formatTaskNotification(baseRecord, 500);
    expect(xml).toContain("<task-notification>");
    expect(xml).toContain("</task-notification>");
    expect(xml).toContain("<task-id>agent-1</task-id>");
    expect(xml).toContain("<status>Done</status>");
  });

  it("truncates long results", () => {
    const longResult = "x".repeat(600);
    const record = createTestSubagent({ result: longResult });
    const xml = formatTaskNotification(record, 100);
    expect(xml).toContain("truncated");
    expect(xml).not.toContain(longResult);
  });

  it("shows No output when result is undefined", () => {
    const record = createTestSubagent({ result: undefined });
    const xml = formatTaskNotification(record, 500);
    expect(xml).toContain("No output.");
  });

  it("includes toolCallId from record.toolCallId when present", () => {
    const record = createTestSubagent({ toolCallId: "tc-123" });
    const xml = formatTaskNotification(record, 500);
    expect(xml).toContain("<tool-use-id>tc-123</tool-use-id>");
  });

  it("excludes toolCallId when absent", () => {
    const xml = formatTaskNotification(baseRecord, 500);
    expect(xml).not.toContain("tool-use-id");
  });

  describe("an agent stopped before it ever started", () => {
    // Stats are seeded non-zero by the factory: a never-started block omits
    // <usage> because the agent never ran, not because the numbers are zero.
    const neverStarted = createTestSubagent({
      status: "stopped",
      stoppedWhileQueued: true,
      result: undefined,
      toolCallId: "tc-123",
    });

    it("emits a trimmed block that claims no result and no usage", () => {
      expect(formatTaskNotification(neverStarted, 500)).toBe(
        [
          "<task-notification>",
          "<task-id>agent-1</task-id>",
          "<tool-use-id>tc-123</tool-use-id>",
          "<status>Stopped before starting</status>",
          '<summary>Subagent "Test task" was stopped while queued and never started</summary>',
          "</task-notification>",
        ].join("\n"),
      );
    });

    it("omits the tool-use-id when the spawn carried none", () => {
      const record = createTestSubagent({
        status: "stopped",
        stoppedWhileQueued: true,
        result: undefined,
      });
      expect(formatTaskNotification(record, 500)).not.toContain("tool-use-id");
    });
  });
});

describe("buildNotificationDetails", () => {
  const baseRecord = createTestSubagent({
    description: "Test",
    result: "Done.",
    toolUses: 2,
    completedAt: 3000,
    lifetimeUsage: { input: 100, output: 200, cacheWrite: 0 },
  });

  it("maps record fields to notification shape", () => {
    const details = buildNotificationDetails(baseRecord, 500);
    expect(details.id).toBe("agent-1");
    expect(details.description).toBe("Test");
    expect(details.status).toBe("completed");
    expect(details.toolUses).toBe(2);
    expect(details.durationMs).toBe(2000);
    expect(details.totalTokens).toBe(300);
    expect(details.resultPreview).toBe("Done.");
  });

  it("carries the run's turn budget", () => {
    const record = createTestSubagent({ turnBudget: { maxTurns: 2, used: 3, phase: "warned" } });
    expect(buildNotificationDetails(record, 500).turnBudget).toEqual({
      maxTurns: 2,
      used: 3,
      phase: "warned",
    });
  });

  it("truncates long result previews with ellipsis", () => {
    const record = createTestSubagent({
      description: "Test",
      result: "x".repeat(600),
      toolUses: 2,
      completedAt: 3000,
      lifetimeUsage: { input: 100, output: 200, cacheWrite: 0 },
    });
    const details = buildNotificationDetails(record, 100);
    expect(details.resultPreview).toHaveLength(101); // 100 chars + "…"
    expect(details.resultPreview.endsWith("…")).toBe(true);
  });

  it("previews a never-started agent as never started, not as empty output", () => {
    const record = createTestSubagent({
      status: "stopped",
      stoppedWhileQueued: true,
      result: undefined,
    });
    const details = buildNotificationDetails(record, 500);
    expect(details.resultPreview).toBe("Never started — stopped while queued.");
  });
});

describe("buildEventData", () => {
  const baseRecord = createTestSubagent({
    type: "explore",
    description: "Search files",
    result: "Found 3 files",
    toolUses: 5,
    lifetimeUsage: { input: 1000, output: 500, cacheWrite: 0 },
  });

  it("includes all expected fields", () => {
    const data = buildEventData(baseRecord);
    expect(data).toEqual({
      id: "agent-1",
      type: "explore",
      description: "Search files",
      result: "Found 3 files",
      error: undefined,
      status: "completed",
      toolUses: 5,
      durationMs: 1000,
      tokens: { input: 1000, output: 500, total: 1500 },
    });
  });

  it("carries the run's turn budget", () => {
    const record = createTestSubagent({
      turnBudget: { maxTurns: 2, used: 7, phase: "exhausted" },
      status: "aborted",
    });
    expect(buildEventData(record).turnBudget).toEqual({ maxTurns: 2, used: 7, phase: "exhausted" });
  });

  it("omits tokens when total is zero", () => {
    const record = createTestSubagent({
      type: "explore",
      description: "Search files",
      result: "Found 3 files",
      toolUses: 5,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    });
    const data = buildEventData(record);
    expect(data.tokens).toBeUndefined();
  });

  it("uses Date.now() fallback when completedAt is undefined", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    const record = createTestSubagent({
      type: "explore",
      description: "Search files",
      result: "Found 3 files",
      toolUses: 5,
      lifetimeUsage: { input: 1000, output: 500, cacheWrite: 0 },
      completedAt: undefined,
    });
    const data = buildEventData(record);
    expect(data.durationMs).toBe(4000); // 5000 - 1000
    vi.useRealTimers();
  });
});

// ---- The messages a work item delivers ----

describe("completionMessage", () => {
  const baseRecord = createTestSubagent({
    description: "Test",
    result: "Done.",
    toolUses: 2,
    lifetimeUsage: { input: 100, output: 200, cacheWrite: 0 },
  });

  it("is a subagent:completion message with the notification block and the details", () => {
    const message = completionMessage(baseRecord);
    expect(message.customType).toBe("subagent:completion");
    expect(message.content).toContain(formatTaskNotification(baseRecord, 500));
    expect(message.details).toEqual(
      JSON.parse(JSON.stringify(buildNotificationDetails(baseRecord, 500))),
    );
  });

  it("previews the result at 500 characters", () => {
    const long = createTestSubagent({ result: "x".repeat(600) });
    const message = completionMessage(long);
    expect(message.content).toContain("x".repeat(500) + "\n...(truncated, use subagent_get");
    expect((message.details as { resultPreview: string }).resultPreview).toBe(
      "x".repeat(500) + "…",
    );
  });

  it("every completion carries the retrieval instruction", () => {
    expect(completionMessage(baseRecord).content).toContain("subagent_get");
  });

  it("surfaces a declared question as answerable", () => {
    const content = completionMessage(
      createTestSubagent({ id: "agent-3", pendingQuestion: "Which config?", sessionReady: true }),
    ).content as string;
    expect(content).toContain("This agent is waiting on an answer:");
    expect(content).toContain("Which config?");
    expect(content).toContain('subagent_send with agent_id: "agent-3"');
  });

  it("omits the retrieval instruction for an agent that never started", () => {
    const record = createTestSubagent({
      status: "stopped",
      stoppedWhileQueued: true,
      result: undefined,
    });
    expect(completionMessage(record).content).toBe(formatTaskNotification(record, 500));
  });

  it("leads the pointer lines with the updates no announcement delivered", () => {
    const record = createTestSubagent({ runUpdates: ["Course change."] });
    expect(completionMessage(record).content).toContain(
      "Updates this agent sent while it worked:\n\n  Course change.",
    );
  });
});

describe("updateMessage", () => {
  it("is a subagent:update message naming the agent and still-running affordance", () => {
    const record = createTestSubagent({ id: "live-1", status: "running" });
    const message = updateMessage(record, "Course change.");
    expect(message.customType).toBe("subagent:update");
    expect(message.content).toBe(formatUpdateNotification(record, "Course change."));
    expect(message.content).toContain("The agent is still running.");
    expect(message.details).toEqual({
      id: "live-1",
      description: record.description,
      message: "Course change.",
    });
  });
});
