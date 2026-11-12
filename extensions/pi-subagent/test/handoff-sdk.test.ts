import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import {
  CHILD_MARK,
  EXTENSIONS,
  scriptSides,
  offlineAgentDir,
  realChildSession,
  lifecycleLog,
  agentIdIn,
  lastResult,
} from "#test/helpers/sdk";
import { toolCall } from "#test-helpers";

// A real orchestrator session loads this extension and spawns a worker through
// the subagent_start tool; the worker's lifecycle events reach the orchestrator's bus.
it("carries the agent id, tool call id and any extension's handoff on a tool-spawned child's lifecycle events", async () => {
  const dir = offlineAgentDir({ extensions: [EXTENSIONS.subagent, EXTENSIONS.lifecycleRecorder] });
  const lifecycle = lifecycleLog();
  const { session: orchestrator, faux } = await realChildSession(dir, {
    type: "orchestrate",
    provider: "handoff-test",
  });
  let workerId: string | undefined;
  const { requests } = scriptSides(faux, {
    parent: [
      toolCall(
        "subagent_start",
        {
          subagent_type: "general-purpose",
          description: "Audit auth",
          prompt: `${CHILD_MARK} Audit the auth module.`,
          handoff: {
            todos: { keys: ["auth-audit", "auth-tests"], scope: "ledger" },
            review: { ticket: "AUTH-12" },
          },
        },
        "call-spawn-1",
      ),
      (context) => {
        workerId = agentIdIn(lastResult(context, "subagent_start"));
        return fauxAssistantMessage("Delegated.");
      },
      // The worker's completion message wakes the orchestrator once more.
      fauxAssistantMessage("Noted."),
    ],
    child: [fauxAssistantMessage("Audit done.")],
  });

  await orchestrator.runTurnLoop("Delegate the audit.", {});
  await vi.waitFor(() => expect(requests.parent).toHaveLength(3), { timeout: 10_000 });
  await orchestrator.session.waitForIdle();
  expect(workerId).toBeTruthy();
  await orchestrator.dispose();

  const log = lifecycle();
  const created = log.find((entry) => entry.channel === "subagent:session:created")?.data;
  expect(created).toEqual({
    sessionId: expect.any(String),
    parentSessionId: expect.any(String),
    agentId: workerId,
    toolCallId: "call-spawn-1",
    handoff: {
      todos: { keys: ["auth-audit", "auth-tests"], scope: "ledger" },
      review: { ticket: "AUTH-12" },
    },
    cwd: dir,
  });
  for (const channel of ["subagent:session:bound", "subagent:session:disposed"]) {
    expect(log.find((entry) => entry.channel === channel)?.data, channel).toMatchObject({
      sessionId: created!.sessionId,
      agentId: workerId,
      toolCallId: "call-spawn-1",
    });
  }
}, 20_000);
