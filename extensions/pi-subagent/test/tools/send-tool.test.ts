import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { SendRefusalReason, SendResult } from "#src/lifecycle/subagent-manager";
import { SendTool, type SendToolEvents, type SendToolManager } from "#src/tools/send-tool";
import type { Subagent } from "#src/types";
import { createTestSubagent } from "#test/helpers/make-subagent";
import {
  createMockSession,
  createSubagentSessionStub,
  toSubagentSession,
} from "#test/helpers/mock-session";
import { STUB_CTX } from "#test/helpers/stub-ctx";

// Replaces steer-tool.test.ts and the resume tests of agent-tool.test.ts (roadmap step 7b):
// the same guarantees, now on the one tool that reaches an agent in any state.

const registry = new AgentTypeRegistry(() => new Map());

function makeManager(result: SendResult) {
  return { send: vi.fn(async () => result) } satisfies SendToolManager;
}

function makeEvents() {
  return { emit: vi.fn<(name: string, data: unknown) => void>() } satisfies SendToolEvents;
}

async function execute(
  manager: SendToolManager,
  events: SendToolEvents = makeEvents(),
  params: { agent_id: string; message: string } = { agent_id: "agent-1", message: "hi" },
  maxConcurrent = 4,
) {
  const tool = new SendTool(manager, events, registry, { maxConcurrent });
  return tool.execute("tc-1", params, new AbortController().signal, undefined, STUB_CTX);
}

const refused = (reason: SendRefusalReason, transcriptPath?: string): SendResult => ({
  kind: "refused",
  reason,
  ...(transcriptPath ? { transcriptPath } : {}),
});

describe("SendTool definition", () => {
  const def = new SendTool(makeManager(refused("unknown-agent")), makeEvents(), registry, {
    maxConcurrent: 4,
  }).toToolDefinition();

  it("is subagent_send, taking an agent and a message", () => {
    expect(def.name).toBe("subagent_send");
    expect(Object.keys((def.parameters as { properties: object }).properties)).toEqual([
      "agent_id",
      "message",
    ]);
  });

  it("includes promptSnippet", () => {
    expect(def.promptSnippet).toBe(
      "Send a message to a background agent in any state: steer a running one, or give an idle one more work.",
    );
  });

  it("documents what the message does in every state, including the agent that never had a session", () => {
    expect(def.description).toContain("Running:");
    expect(def.description).toContain("Queued (waiting for a concurrency slot)");
    expect(def.description).toContain("Stopping that waiting run drops the message.");
    expect(def.description).toContain("Idle (finished, failed, hit its turn limit or stopped)");
    expect(def.description).toContain("saved transcript is reopened");
    expect(def.description).toContain("Idle and never had a session");
    expect(def.description).toContain("from its original task followed by the message");
    expect(def.description).toContain("After a reload the original task is gone");
    expect(def.description).toContain("concurrency limit");
  });
});

describe("SendTool — a running agent", () => {
  it("sends the message to the manager under the agent id", async () => {
    const manager = makeManager({
      kind: "steered",
      delivery: "delivered",
      record: createTestSubagent({ status: "running", sessionReady: true }),
    });

    await execute(manager, makeEvents(), { agent_id: "agent-1", message: "change plan" });

    expect(manager.send).toHaveBeenCalledWith("agent-1", "change plan");
  });

  it("reports a delivered steer with the agent's live state, and emits subagent:steered", async () => {
    const record = createTestSubagent({ id: "agent-1", status: "running" });
    const mockSession = createMockSession();
    record.subagentSession = toSubagentSession(createSubagentSessionStub(mockSession));
    const events = makeEvents();

    const result = await execute(
      makeManager({ kind: "steered", delivery: "delivered", record }),
      events,
      { agent_id: "agent-1", message: "change plan" },
    );

    expect(result.content[0].text).toContain("Steering message sent to agent agent-1.");
    expect(result.content[0].text).toContain("3 tool uses");
    expect(events.emit).toHaveBeenCalledWith("subagent:steered", {
      id: "agent-1",
      message: "change plan",
    });
  });

  it("reports a held steer as queued for the session, and emits subagent:steered", async () => {
    const record = createTestSubagent({ id: "agent-1", status: "running" });
    const events = makeEvents();

    const result = await execute(
      makeManager({ kind: "steered", delivery: "buffered", record }),
      events,
      { agent_id: "agent-1", message: "redirect" },
    );

    expect(result.content[0].text).toBe(
      "Steering message queued for agent agent-1. It will be delivered once the session initializes.",
    );
    expect(events.emit).toHaveBeenCalledWith("subagent:steered", {
      id: "agent-1",
      message: "redirect",
    });
  });

  it("returns an error message when the steer fails", async () => {
    const manager = { send: vi.fn().mockRejectedValue(new Error("session closed")) };

    const result = await execute(manager);

    expect(result.content[0].text).toBe("Failed to send message to agent: session closed");
  });
});

describe("SendTool — a queued agent", () => {
  it("says the message joined the waiting run, and emits subagent:steered", async () => {
    const record = createTestSubagent({ id: "agent-1", status: "queued", completedAt: undefined });
    const events = makeEvents();

    const result = await execute(makeManager({ kind: "joined", record }), events, undefined, 2);

    expect(result.content[0].text).toBe(
      "Agent agent-1 is queued for a concurrency slot (max 2 concurrent) and has not started. " +
        "Your message was added to the prompt of the run that is waiting, so the agent sees it when it starts. " +
        "If that run is stopped before its slot opens, the message is dropped.",
    );
    expect(events.emit).toHaveBeenCalledWith("subagent:steered", { id: "agent-1", message: "hi" });
  });
});

describe("SendTool — an idle agent", () => {
  const started = (record: Subagent, relaunched = false): SendResult => ({
    kind: "started",
    relaunched,
    record,
  });

  it("returns the background launch message for the resumed agent", async () => {
    const record = createTestSubagent({ id: "agent-1", description: "answer" });

    const result = await execute(makeManager(started(record)));

    expect(result.content[0].text).toBe(
      "Agent resumed in background.\n" +
        "Agent ID: agent-1\n" +
        "Type: agent\n" +
        "Description: answer\n" +
        "\nYou will be notified when this agent completes.\n" +
        "Use subagent_get to retrieve full results, or subagent_send to send it messages.\n" +
        "Do not duplicate this agent's work.",
    );
    expect(result.details).toMatchObject({ status: "background", agentId: "agent-1" });
  });

  it("says the run waits for a slot when the limiter has none free", async () => {
    const record = createTestSubagent({ status: "queued", completedAt: undefined });

    const result = await execute(makeManager(started(record)), undefined, undefined, 3);

    expect(result.content[0].text).toContain("Agent resume queued in background.\n");
    expect(result.content[0].text).toContain("Position: queued (max 3 concurrent)");
  });

  it("starts nothing the tool waits for, and leaves the outcome to the completion message", async () => {
    const record = createTestSubagent();

    await execute(makeManager(started(record)));

    expect(record.consumed).toBe(false);
  });

  it("emits no steered event for a run it starts", async () => {
    const events = makeEvents();

    await execute(makeManager(started(createTestSubagent())), events);

    expect(events.emit).not.toHaveBeenCalled();
  });

  it("says a first run was started for an agent that never had a session", async () => {
    const record = createTestSubagent();

    const result = await execute(makeManager(started(record, true)));

    expect(result.content[0].text).toMatch(
      /^Note: this agent never started a session, so this is its first run: its original task followed by your message\.\n/,
    );
    expect(result.content[0].text).toContain("Agent started in background.\n");
  });

  it("says a first run waits for a slot too", async () => {
    const record = createTestSubagent({ status: "queued", completedAt: undefined });

    const result = await execute(makeManager(started(record, true)));

    expect(result.content[0].text).toContain("Agent queued in background.\n");
  });
});

describe("SendTool — refusals", () => {
  const text = async (result: SendResult) => (await execute(makeManager(result))).content[0].text;

  it("names an id no record answers to", async () => {
    expect(await text(refused("unknown-agent"))).toBe(
      'Agent not found: "agent-1". It is not live in this session; subagent_get without ' +
        "agent_id lists the agents started on this branch, including any from before a reload or resume.",
    );
  });

  it("points a released agent at subagent_get instead of sending", async () => {
    expect(await text(refused("session-released"))).toBe(
      'Agent "agent-1" had its session released and its saved transcript is gone; it cannot take a message, ' +
        "but its result is still retrievable via subagent_get.",
    );
  });

  it("says an agent that never had a session, with no saved task, needs a new agent", async () => {
    expect(await text(refused("no-session"))).toBe(
      'Agent "agent-1" never started a session, and its original task was not saved across the reload, so it cannot take a message. ' +
        "Spawn a new agent with the task.",
    );
  });

  it("says a removed directory means a new agent", async () => {
    expect(await text(refused("directory-unavailable"))).toBe(
      'Agent "agent-1" cannot take a message: the directory it ran in no longer exists. ' +
        "Spawn a new agent with the context it needs.",
    );
  });

  it("says an unavailable agent type means a new agent", async () => {
    expect(await text(refused("agent-type-unavailable"))).toBe(
      'Agent "agent-1" cannot take a message: its agent type is no longer available. ' +
        "Spawn a new agent with the context it needs.",
    );
  });

  it("tells the parent to try again when a stopped rebuild still owns the transcript", async () => {
    expect(await text(refused("rebuilding"))).toBe(
      'Agent "agent-1" was stopped while its session was being created or rebuilt and is still shutting down. ' +
        "Send the message again in a moment.",
    );
  });

  it("names the transcript when the agent has one", async () => {
    expect(await text(refused("directory-unavailable", "/tasks/agent-1.jsonl"))).toMatch(
      /\n\nIts transcript is at: \/tasks\/agent-1\.jsonl$/,
    );
  });

  it("emits no event for a message that went nowhere", async () => {
    const events = makeEvents();

    await execute(makeManager(refused("unknown-agent")), events);

    expect(events.emit).not.toHaveBeenCalled();
  });
});
