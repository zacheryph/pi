import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import {
  CHILD_MARK,
  EXTENSIONS,
  offlineAgentDir,
  realChildSession,
  lifecycleLog,
  agentIdIn,
  lastResult,
  scriptSides,
} from "#test/helpers/sdk";
import { toolCall } from "#test-helpers";

// A real orchestrator session hands a worker a directory it owns (a worktree)
// through subagent_start's cwd, then resumes the worker there; both runs finish
// with a completion message that wakes the orchestrator.
it("runs a tool-spawned child in the caller's cwd and keeps it reachable", async () => {
  const dir = offlineAgentDir({ extensions: [EXTENSIONS.subagent, EXTENSIONS.lifecycleRecorder] });
  const lifecycle = lifecycleLog();
  const { session: orchestrator, faux } = await realChildSession(dir, {
    type: "orchestrate",
    provider: "cwd-test",
  });
  const worktree = join(dir, "worktrees", "feat-x");
  mkdirSync(worktree, { recursive: true });
  let workerId: string | undefined;
  const { requests } = scriptSides(faux, {
    parent: [
      toolCall(
        "subagent_start",
        {
          subagent_type: "general-purpose",
          description: "Build feature",
          prompt: `${CHILD_MARK} Build the feature.`,
          cwd: "worktrees/feat-x",
        },
        "call-spawn-1",
      ),
      fauxAssistantMessage("Started."),
      // The first completion message wakes the orchestrator, which messages the worker.
      (context) => {
        workerId = agentIdIn(lastResult(context, "subagent_start"));
        return toolCall(
          "subagent_send",
          { agent_id: workerId ?? "", message: `${CHILD_MARK} Add the tests.` },
          "call-send-1",
        );
      },
      fauxAssistantMessage("Resumed."),
      fauxAssistantMessage("Delegated."),
    ],
    child: [fauxAssistantMessage("First pass done."), fauxAssistantMessage("Tests added.")],
  });

  await orchestrator.runTurnLoop("Delegate the feature.", {});
  await vi.waitFor(() => expect(requests.parent).toHaveLength(5), { timeout: 10_000 });
  await orchestrator.session.waitForIdle();
  expect(workerId).toBeTruthy();
  const sendResult = lastResult(requests.parent[3], "subagent_send");
  expect(lastResult(requests.parent[3], "subagent_send")).toContain("Agent resumed in background.");
  expect(JSON.stringify(requests.parent[4].messages.at(-1))).toContain("Tests added.");
  expect(sendResult).not.toContain("cannot take a message");
  await orchestrator.dispose();

  const log = lifecycle();
  const created = log.filter((entry) => entry.channel === "subagent:session:created");
  expect(created).toHaveLength(1);
  expect(created[0].data).toMatchObject({ agentId: workerId, cwd: worktree });
}, 20_000);
