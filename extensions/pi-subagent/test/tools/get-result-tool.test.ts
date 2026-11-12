import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { SendRefusal } from "#src/lifecycle/subagent";
import type { DisplayStatus, SubagentStatus } from "#src/lifecycle/subagent-state";
import { MAX_EXPANDED_LINES, PREVIEW_CHARS } from "#src/tools/get-result-renderer";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type PersistedSubagentRecord, SUBAGENT_RECORD_ENTRY } from "#src/persisted-record";
import {
  agentNotFoundMessage,
  GetResultTool,
  type GetResultToolManager,
} from "#src/tools/get-result-tool";
import type { Subagent } from "#src/types";
import type { Theme } from "#src/ui/display";
import { makeModel } from "#test/helpers/make-model";
import { createTestSubagent, makeStubExecution, stateForLabel } from "#test/helpers/make-subagent";
import {
  createMockSession,
  createSubagentSessionStub,
  openItem,
  toSubagentSession,
} from "#test/helpers/mock-session";
import { STUB_CTX } from "#test/helpers/stub-ctx";
import { plainTheme, markupTheme } from "#test-helpers";

const testRegistry = new AgentTypeRegistry(() => new Map());

/** A result body long enough to overflow the expanded cap, with a recognisable last line. */
function longResult(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `report line ${i + 1}`).join("\n");
}

function makeManager(
  records: Map<string, Subagent> = new Map(),
  savedRefusal?: SendRefusal,
): GetResultToolManager {
  return {
    getRecord: (id: string) => records.get(id),
    listAgents: () => [...records.values()],
    sendRefusalFor: ({ id }) => {
      const live = records.get(id);
      return live ? live.sendRefusal : savedRefusal;
    },
  };
}

async function execute(
  manager: GetResultToolManager,
  params: { agent_id: string; verbose?: boolean },
) {
  const tool = new GetResultTool(manager, testRegistry);
  return tool.execute("tc-1", params, undefined, undefined, STUB_CTX);
}

describe("GetResultTool", () => {
  it("returns tool definition with correct name", () => {
    const tool = new GetResultTool(makeManager(), testRegistry);
    expect(tool.toToolDefinition().name).toBe("subagent_get");
  });

  it("includes promptSnippet", () => {
    const tool = new GetResultTool(makeManager(), testRegistry);
    expect(tool.toToolDefinition().promptSnippet).toBe(
      "Check status and retrieve results from a background agent, or list this branch's agents.",
    );
  });

  it("returns not-found message for unknown agent ID", async () => {
    const result = await execute(makeManager(), { agent_id: "unknown" });
    expect(result.content[0].text).toContain("Agent not found");
  });

  it("returns status and result for completed agent", async () => {
    const records = new Map([["agent-1", createTestSubagent()]]);
    const result = await execute(makeManager(records), { agent_id: "agent-1" });
    const text = result.content[0].text;
    expect(text).toContain("Agent: agent-1");
    expect(text).toContain("completed");
    expect(text).toContain("All done.");
  });

  describe("model", () => {
    it("names the model the agent ran in the report and the TUI details", async () => {
      const record = createTestSubagent({
        execution: makeStubExecution({ model: makeModel({ provider: "openai", id: "gpt-5" }) }),
      });
      const result = await execute(makeManager(new Map([["agent-1", record]])), {
        agent_id: "agent-1",
      });
      expect(result.content[0].text).toContain("\nModel: openai/gpt-5\n");
      expect(result.details?.modelName).toBe("openai/gpt-5");
    });

    it("names no model while the agent's model is unknown", async () => {
      const result = await execute(makeManager(new Map([["agent-1", createTestSubagent()]])), {
        agent_id: "agent-1",
      });
      expect(result.content[0].text).not.toContain("Model:");
      expect(result.details?.modelName).toBeUndefined();
    });
  });

  it("reports the updates the agent sent during the run", async () => {
    const records = new Map([
      ["agent-1", createTestSubagent({ runUpdates: ["The bug is in the retry wrapper."] })],
    ]);

    const result = await execute(makeManager(records), { agent_id: "agent-1" });

    expect(result.content[0].text).toContain("The bug is in the retry wrapper.");
  });

  // Rewritten by roadmap step 10 (was: the report quoted a question the agent "ended its turn
  // with" and named the send call, also for a child that asked before its turn ended). A question
  // is an open item: the agent is waiting on `answer`, and the parent heard the question when it
  // was asked.
  describe("an agent waiting for an answer", () => {
    it("is waiting on `answer`, and says a message wakes it", async () => {
      const record = createTestSubagent({ sessionReady: true });
      const session = record.subagentSession as unknown as ReturnType<
        typeof createSubagentSessionStub
      >;
      session.openItems.push(openItem("answer", "q1", "question"));
      const result = await execute(makeManager(new Map([["agent-1", record]])), {
        agent_id: "agent-1",
      });

      expect(result.content[0].text).toContain("Status: waiting: answer");
      expect(result.content[0].text).toContain("or when you send it a message");
    });

    it("forwards the record's refusal, so a swept record names no send", async () => {
      const released = createTestSubagent({ sessionReady: true });
      await released.releaseSession();
      const records = new Map([["agent-1", released]]);

      const result = await execute(makeManager(records), { agent_id: "agent-1" });

      expect(result.content[0].text).toContain(
        "its session was released and its saved transcript is gone",
      );
      expect(result.content[0].text).not.toContain("subagent_send");
    });
  });

  it("shows running message for in-progress agent", async () => {
    const records = new Map([
      ["agent-1", createTestSubagent({ status: "running", completedAt: undefined })],
    ]);
    const result = await execute(makeManager(records), { agent_id: "agent-1" });
    expect(result.content[0].text).toContain("still running");
  });

  it("shows error for failed agent", async () => {
    const records = new Map([
      ["agent-1", createTestSubagent({ status: "error", error: "timeout" })],
    ]);
    const result = await execute(makeManager(records), { agent_id: "agent-1" });
    expect(result.content[0].text).toContain("Error: timeout");
  });

  it("marks the record consumed for a completed agent (pull-delivery edge)", async () => {
    const record = createTestSubagent({ toolCallId: "tc-1" });
    const records = new Map([["agent-1", record]]);
    await execute(makeManager(records), { agent_id: "agent-1" });
    expect(record.consumed).toBe(true);
  });

  it("marks consumed even for a completed agent without a toolCallId", async () => {
    const record = createTestSubagent();
    const records = new Map([["agent-1", record]]);
    await execute(makeManager(records), { agent_id: "agent-1" });
    expect(record.consumed).toBe(true);
  });

  it("does not mark a running agent consumed", async () => {
    const record = createTestSubagent({ status: "running", completedAt: undefined });
    const records = new Map([["agent-1", record]]);
    await execute(makeManager(records), { agent_id: "agent-1" });
    expect(record.consumed).toBe(false);
  });

  it("has no wait parameter: a running agent is reported at once", async () => {
    const sessionStub = createSubagentSessionStub();
    // A run that never settles: a call that waited for it would never return.
    sessionStub.runTurnLoop.mockReturnValue(new Promise<never>(() => {}));
    const record = createTestSubagent({
      status: "running",
      completedAt: undefined,
      execution: makeStubExecution({
        createSubagentSession: async () => toSubagentSession(sessionStub),
      }),
    });
    record.start();
    const tool = new GetResultTool(makeManager(new Map([["agent-1", record]])), testRegistry);

    const schema = tool.toToolDefinition().parameters as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(["agent_id", "verbose"]);

    const result = await tool.execute(
      "tc-1",
      { agent_id: "agent-1", wait: true } as { agent_id: string },
      undefined,
      undefined,
      STUB_CTX,
    );
    expect(result.content[0].text).toContain("Status: running");
    expect(result.content[0].text).toContain("completion message arrives when it finishes");
    expect(record.consumed).toBe(false);
  });

  it("reports an idle agent with open work as waiting", async () => {
    const record = createTestSubagent({ sessionReady: true });
    const session = record.subagentSession as unknown as ReturnType<
      typeof createSubagentSessionStub
    >;
    session.openItems.push(openItem("CI"));
    const result = await execute(makeManager(new Map([["agent-1", record]])), {
      agent_id: "agent-1",
    });
    expect(result.content[0].text).toContain("Status: waiting: CI");
    // The retention rule keeps its session while the work is open, read or not.
    expect(record.hasOpenWork()).toBe(true);
    // A waiting agent has no finished result: reading it does not start the short window (roadmap
    // step 11), which would otherwise be running when the work ends.
    expect(record.consumed).toBe(false);
  });

  it("leaves the completion message owed after reading a finished result", async () => {
    // Reading a result starts the retention clock and nothing else: the record
    // keeps its updates for the completion message and claims no outcome.
    const record = createTestSubagent({ runUpdates: ["Course change."] });
    await execute(makeManager(new Map([["agent-1", record]])), { agent_id: "agent-1" });
    expect(record.consumed).toBe(true);
    expect(record.runUpdates).toEqual(["Course change."]);
  });

  it("includes conversation when verbose=true", async () => {
    const record = createTestSubagent();
    const stub = createSubagentSessionStub();
    stub.getConversation.mockReturnValue("[User]: hello");
    record.subagentSession = toSubagentSession(stub);
    const records = new Map([["agent-1", record]]);
    const result = await execute(makeManager(records), { agent_id: "agent-1", verbose: true });
    expect(result.content[0].text).toContain("--- Agent Conversation ---");
    expect(result.content[0].text).toContain("[User]: hello");
  });

  it("points to the transcript when verbose is requested but the session was released", async () => {
    const record = createTestSubagent();
    record.subagentSession = toSubagentSession(
      createSubagentSessionStub(createMockSession(), "/tasks/agent.jsonl"),
    );
    await record.releaseSession();
    const records = new Map([["agent-1", record]]);
    const result = await execute(makeManager(records), { agent_id: "agent-1", verbose: true });
    expect(result.content[0].text).toContain("Full transcript available at: /tasks/agent.jsonl");
    expect(result.content[0].text).not.toContain("--- Agent Conversation ---");
  });
});

describe("GetResultTool — TUI rendering", () => {
  const theme: Theme = markupTheme;

  // The registered hooks take Pi's full Theme; `display.ts` narrows it to the two
  // methods the renderers call, so a double is structurally short of the SDK type.
  const asSdkTheme = theme as never;

  function renderRows(
    result: Awaited<ReturnType<GetResultTool["execute"]>>,
    expanded: boolean,
    width = 100,
  ): string[] {
    const { renderResult } = new GetResultTool(makeManager(), testRegistry).toToolDefinition();
    if (!renderResult) throw new Error("subagent_get registers no renderResult");
    const component = renderResult(
      result,
      { expanded, isPartial: false },
      asSdkTheme,
      undefined as never,
    );
    return component.render(width);
  }

  describe("result rendering", () => {
    it("spends three rows on a collapsed result, however long the report", async () => {
      const records = new Map([["agent-1", createTestSubagent({ result: longResult(200) })]]);

      const result = await execute(makeManager(records), { agent_id: "agent-1" });

      expect(renderRows(result, false)).toHaveLength(3);
    });

    it("bounds an expanded result at the cap plus its indicator row", async () => {
      const records = new Map([["agent-1", createTestSubagent({ result: longResult(200) })]]);

      const result = await execute(makeManager(records), { agent_id: "agent-1" });

      expect(renderRows(result, true)).toHaveLength(MAX_EXPANDED_LINES + 1);
    });

    it("spends one row per line whatever the terminal width", async () => {
      const records = new Map([["agent-1", createTestSubagent({ result: "x".repeat(526) })]]);

      const result = await execute(makeManager(records), { agent_id: "agent-1" });

      for (const width of [40, 80, 120]) {
        expect(renderRows(result, false, width)).toHaveLength(3);
      }
    });

    it("falls back to the plain message when there is no record to summarise", async () => {
      const result = await execute(makeManager(), { agent_id: "ghost" });

      expect(renderRows(result, false).join("\n")).toContain("Agent not found");
    });
  });

  describe("call rendering", () => {
    it("names the agent being retrieved", () => {
      const { renderCall } = new GetResultTool(makeManager(), testRegistry).toToolDefinition();
      if (!renderCall) throw new Error("subagent_get registers no renderCall");

      const rows = renderCall({ agent_id: "agent-42" }, asSdkTheme, undefined as never).render(100);

      expect(rows.join("\n")).toContain("agent-42");
    });
  });

  describe("details payload", () => {
    it("carries the run's turn budget and names its wrap-up in the report", async () => {
      const turnBudget = { maxTurns: 2, used: 3, phase: "warned" } as const;
      const records = new Map([["agent-1", createTestSubagent({ turnBudget })]]);

      const result = await execute(makeManager(records), { agent_id: "agent-1" });

      expect(result.details?.turnBudget).toEqual(turnBudget);
      expect(result.content[0].text).toContain(
        "Status: completed (wrapped up \u2014 after turn-budget warning) |",
      );
    });

    it("carries a preview bounded well below the result it summarises", async () => {
      const records = new Map([["agent-1", createTestSubagent({ result: longResult(200) })]]);

      const result = await execute(makeManager(records), { agent_id: "agent-1" });

      expect(result.details?.preview?.length).toBeLessThanOrEqual(PREVIEW_CHARS);
    });

    it("never duplicates the result body into the session entry", async () => {
      const records = new Map([["agent-1", createTestSubagent({ result: longResult(200) })]]);

      const result = await execute(makeManager(records), { agent_id: "agent-1" });

      expect(JSON.stringify(result.details)).not.toContain("report line 200");
    });

    it("never carries the conversation, even when verbose was requested", async () => {
      const record = createTestSubagent();
      const stub = createSubagentSessionStub();
      stub.getConversation.mockReturnValue("[User]: hello");
      record.subagentSession = toSubagentSession(stub);

      const result = await execute(makeManager(new Map([["agent-1", record]])), {
        agent_id: "agent-1",
        verbose: true,
      });

      expect(result.details?.verbose).toBe(true);
      expect(JSON.stringify(result.details)).not.toContain("[User]: hello");
    });

    it("omits details entirely when there is no record", async () => {
      const result = await execute(makeManager(), { agent_id: "ghost" });

      expect(result.details).toBeUndefined();
    });
  });
});

describe("GetResultTool — the branch's saved records", () => {
  /** A saved record; `status` also takes today's display labels (see `stateForLabel`). */
  function savedRecord(
    overrides: Omit<Partial<PersistedSubagentRecord>, "status"> & {
      status?: SubagentStatus | DisplayStatus;
    } = {},
  ): PersistedSubagentRecord {
    const { status = "completed", ...rest } = overrides;
    return {
      version: 2,
      id: "saved-1",
      type: "explore",
      description: "map the module",
      ...(status === "idle" ? { status, outcome: "completed" as const } : stateForLabel(status)),
      result: "Mapped it.",
      error: undefined,
      turnBudget: undefined,
      startedAt: 1_000,
      completedAt: 4_000,
      outputFile: "/tasks/saved-1.jsonl",
      toolUses: 7,
      ...rest,
    } as PersistedSubagentRecord;
  }

  /** A Pi context whose current branch holds these records, last step last. */
  function branchCtx(records: PersistedSubagentRecord[]) {
    return {
      sessionManager: {
        getBranch: () =>
          records.map((data) => ({ type: "custom", customType: SUBAGENT_RECORD_ENTRY, data })),
      },
    } as never;
  }

  const tool = (records: Map<string, Subagent> = new Map(), savedRefusal?: SendRefusal) =>
    new GetResultTool(makeManager(records, savedRefusal), testRegistry);
  const signal = new AbortController().signal;

  it("answers from the saved record once no live agent has the ID", async () => {
    const result = await tool().execute(
      "tc",
      { agent_id: "saved-1" },
      signal,
      undefined,
      branchCtx([savedRecord({ model: "anthropic/claude-x", thinkingLevel: "high" })]),
    );
    const text = result.content[0].text;
    expect(text).toContain("Agent: saved-1");
    expect(text).toContain("Status: completed");
    expect(text).toContain("Tool uses: 7");
    expect(text).toContain("Model: anthropic/claude-x (thinking high)");
    expect(text).toContain("Mapped it.");
    expect(text).toContain('Send: available. Call subagent_send with agent_id: "saved-1"');
    expect(text).toContain("Full transcript available at: /tasks/saved-1.jsonl");
    expect(result.details).toMatchObject({ agentId: "saved-1", status: "completed" });
  });

  it("says why a saved agent cannot take a message, and still names its transcript", async () => {
    const result = await tool(new Map(), "directory-unavailable").execute(
      "tc",
      { agent_id: "saved-1" },
      signal,
      undefined,
      branchCtx([savedRecord()]),
    );
    const text = result.content[0].text;
    expect(text).toContain(
      "Send: not available, because the directory it ran in no longer exists.",
    );
    expect(text).not.toContain("subagent_send");
    expect(text).toContain("Full transcript available at: /tasks/saved-1.jsonl");
  });

  // Rewritten by roadmap step 10 (was: a saved record's question was quoted with the send call
  // that answers it, or with why it could not be answered). A record written before the field was
  // removed may still carry a question; it is read like any other saved record, without it.
  it("reads a saved record that still carries a question as an ordinary one", async () => {
    const old = { ...savedRecord(), pendingQuestion: "Postgres or SQLite?" };
    const result = await tool().execute(
      "tc",
      { agent_id: "saved-1" },
      signal,
      undefined,
      branchCtx([old]),
    );
    const text = result.content[0].text;
    expect(text).not.toContain("Postgres or SQLite?");
    expect(text).not.toContain("waiting on an answer");
    expect(text).toContain('Send: available. Call subagent_send with agent_id: "saved-1"');
  });

  it("says why a saved agent cannot take a message", async () => {
    const result = await tool(new Map(), "session-released").execute(
      "tc",
      { agent_id: "saved-1" },
      signal,
      undefined,
      branchCtx([savedRecord()]),
    );
    const text = result.content[0].text;
    expect(text).toContain("Send: not available");
    expect(text).not.toContain("subagent_send");
  });

  it("warns on a listed agent only when send's own check refuses it", () => {
    const line = (refusal?: SendRefusal) =>
      (tool(new Map(), refusal).list(branchCtx([savedRecord()])).content[0] as { text: string })
        .text;
    expect(line()).toMatch(/idle, last run completed \d\d:\d\d$/);
    expect(line()).not.toContain("cannot take a message");
    expect(line("session-released")).toContain("(cannot take a message)");
  });

  it("reports a saved run that never finished as interrupted", async () => {
    const result = await tool().execute(
      "tc",
      { agent_id: "saved-1" },
      signal,
      undefined,
      branchCtx([savedRecord({ status: "running", result: undefined, completedAt: undefined })]),
    );
    expect(result.content[0].text).toContain("Status: interrupted");
    expect(result.content[0].text).toContain("never finished");
    expect(result.content[0].text).not.toContain("Agent is still running");
  });

  it("says where the conversation went when verbose asks for it", async () => {
    const result = await tool().execute(
      "tc",
      { agent_id: "saved-1", verbose: true },
      signal,
      undefined,
      branchCtx([savedRecord()]),
    );
    expect(result.content[0].text).toContain("read the transcript instead");
  });

  it("prefers the live record when both exist", async () => {
    const live = createTestSubagent({ id: "saved-1", status: "completed", result: "Live result." });
    const result = await tool(new Map([["saved-1", live]])).execute(
      "tc",
      { agent_id: "saved-1" },
      signal,
      undefined,
      branchCtx([savedRecord({ result: "Saved result." })]),
    );
    expect(result.content[0].text).toContain("Live result.");
    expect(result.content[0].text).not.toContain("Resume: not available.");
  });

  it("hides a live agent the current branch did not start", async () => {
    const live = createTestSubagent({ id: "elsewhere", status: "completed" });
    const result = await tool(new Map([["elsewhere", live]])).execute(
      "tc",
      { agent_id: "elsewhere" },
      signal,
      undefined,
      branchCtx([]),
    );
    expect(result.content[0].text).toBe(agentNotFoundMessage("elsewhere"));
  });

  it("words not-found as a fact about the branch, not a cleared record", () => {
    expect(agentNotFoundMessage("x")).toBe(
      'Agent not found: "x". No agent with this ID was started on this branch of the session. ' +
        "Call subagent_get without agent_id to list the agents that were.",
    );
  });

  describe("listing (no agent_id)", () => {
    const list = (records: Map<string, Subagent>, ctx: unknown) =>
      tool(records)
        .toToolDefinition()
        .execute("tc", {}, signal, undefined, ctx as never);

    it("lists the branch's agents in roster order with live state overlaid", async () => {
      const running = createTestSubagent({
        id: "run-1",
        status: "running",
        completedAt: undefined,
        description: "still going",
      });
      const asking = createTestSubagent({ id: "ask-1", sessionReady: true });
      (
        asking.subagentSession as unknown as ReturnType<typeof createSubagentSessionStub>
      ).openItems.push(openItem("answer", "q1", "question"));
      const result = await list(
        new Map([
          ["run-1", running],
          ["ask-1", asking],
        ]),
        branchCtx([
          savedRecord({ id: "done-1", completedAt: 5_000 }),
          savedRecord({ id: "run-1", status: "running", description: "still going" }),
          savedRecord({ id: "ask-1" }),
          savedRecord({ id: "bad-1", status: "error", error: "boom" }),
        ]),
      );
      const lines = (result.content[0] as { text: string }).text.split("\n");
      expect(lines[0]).toBe(
        "Agents started on this branch (4; subagent_get <id> for details, subagent_send <id> to give an idle one more work):",
      );
      expect(lines.slice(1).map((line) => line.split(" ")[1])).toEqual([
        "ask-1",
        "run-1",
        "bad-1",
        "done-1",
      ]);
      expect(lines[1]).toContain(": waiting: answer");
      expect(lines[2]).toContain(": running");
      expect(result.details).toEqual({ kind: "list", total: 4 });
    });

    it("leaves out live agents the branch did not start", async () => {
      const live = createTestSubagent({ id: "elsewhere", status: "running" });
      const result = await list(new Map([["elsewhere", live]]), branchCtx([]));
      expect((result.content[0] as { text: string }).text).toBe(
        "No agents were started on this branch of the session.",
      );
      expect(result.details).toEqual({ kind: "list", total: 0 });
    });

    it("lists live agents when there is no session to read", async () => {
      const live = createTestSubagent({ id: "only-live", status: "completed", completedAt: 9 });
      const result = await list(new Map([["only-live", live]]), STUB_CTX);
      expect((result.content[0] as { text: string }).text).toContain("- only-live ");
    });

    it("renders padded rows, collapsed to a count and expanded to the lines", async () => {
      const result = await list(new Map(), branchCtx([savedRecord({ description: "漢字 🎉" })]));
      const theme = plainTheme;
      const { renderResult } = tool().toToolDefinition();
      const render = (expanded: boolean, width: number) =>
        renderResult!(
          result,
          { expanded, isPartial: false },
          theme as never,
          undefined as never,
        ).render(width);
      expect(render(false, 40)).toEqual([` ${"1 agent on this branch".padEnd(38)} `]);
      const expanded = render(true, 60);
      expect(expanded).toHaveLength(2);
      for (const row of expanded) {
        expect(row.startsWith(" ")).toBe(true);
        expect(row.endsWith(" ")).toBe(true);
        expect(visibleWidth(row)).toBe(60);
      }
      expect(expanded[1]).toContain("漢字 🎉");
      // Too narrow for padding plus content: blank rows, never overflow.
      expect(render(true, 2)).toEqual(["  ", "  "]);
      for (const row of render(true, 12)) expect(visibleWidth(row)).toBe(12);
    });
  });
});
