import { expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { SubagentManager } from "#src/lifecycle/subagent-manager";
import { SubagentWork } from "#src/observation/subagent-work";
import { fakeWorkHost } from "#test/helpers/fake-work-host";
import { createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { turnLoopResult } from "#test/helpers/turn-loop-result";

// A turn limit that the harness enforces (as opposed to a warning the agent
// heeds, which completion-message.test.ts covers) ends a run as `aborted`.
// Through a real session on the faux provider that stop surfaces as a provider
// error instead: Pi's model runtime throws "This operation was aborted" on the
// next request, before the provider answers. So this outcome is pinned through
// the manager, with a session that returns the way a real provider's does.

it("reports an agent the harness stopped at its turn limit as Aborted, with the partial result", async () => {
  const fake = fakeWorkHost();
  const work = new SubagentWork(() => fake.host);
  const session = createSubagentSessionStub();
  session.runTurnLoop.mockResolvedValue(
    turnLoopResult({
      responseText: "Got partway.",
      turnBudget: { maxTurns: 2, used: 2, phase: "exhausted" },
    }),
  );
  const manager = new SubagentManager({
    createSubagentSession: async () => toSubagentSession(session),
    observer: {
      onSubagentStarted: () => {},
      onSubagentCompleted: (record) => work.runEnded(record),
      onSubagentResumed: () => {},
      onSubagentResuming: () => {},
      onSubagentCompacted: () => {},
      onSubagentCreated: (record) => work.runRequested(record),
    },
    limiter: new ConcurrencyLimiter(() => 4),
    registry: new AgentTypeRegistry(() => new Map()),
  });

  const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "Work.", {
    description: "Work",
    maxTurns: 2,
    parentSession: { toolCallId: "call-1" },
  });
  await manager.getRecord(id)!.promise;
  await manager.dispose();

  const [message, ...others] = fake.messages();
  expect(others).toEqual([]);
  expect(message.customType).toBe("subagent:completion");
  expect((message.content as string).replace(/<duration_ms>\d+/, "<duration_ms>N")).toBe(
    [
      "<task-notification>",
      `<task-id>${id}</task-id>`,
      "<tool-use-id>call-1</tool-use-id>",
      "<status>Aborted (turn limit reached, output may be incomplete)</status>",
      `<summary>Subagent "Work" aborted</summary>`,
      "<result>Got partway.</result>",
      `<usage><total_tokens>0</total_tokens><tool_uses>0</tool_uses><duration_ms>N</duration_ms></usage>`,
      "</task-notification>",
      `Call subagent_get("${id}") to collect the full result.`,
    ].join("\n"),
  );
  expect(message.details).toMatchObject({ id, status: "aborted", resultPreview: "Got partway." });
  expect(fake.items.map((item) => item.events.map((event) => event.kind))).toEqual([["complete"]]);
}, 15_000);
