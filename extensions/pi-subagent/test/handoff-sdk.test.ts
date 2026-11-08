import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import {
  EXTENSIONS,
  offlineAgentDir,
  realChildSession,
  lifecycleLog,
  agentIdIn,
  lastResult,
} from "./helpers/sdk.ts";
import { toolCall } from "../../../packages/pi-test-helpers/src/faux-session.ts";

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
  faux.setResponses([
    toolCall(
      "subagent_start",
      {
        subagent_type: "general-purpose",
        description: "Audit auth",
        prompt: "Audit the auth module.",
        handoff: {
          todos: { keys: ["auth-audit", "auth-tests"], scope: "ledger" },
          review: { ticket: "AUTH-12" },
        },
      },
      "call-spawn-1",
    ),
    fauxAssistantMessage("Audit done."),
    (context) => {
      const result = lastResult(context, "subagent_start");
      workerId = agentIdIn(result);
      return fauxAssistantMessage("Delegated.");
    },
  ]);

  await orchestrator.runTurnLoop("Delegate the audit.", {});
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
