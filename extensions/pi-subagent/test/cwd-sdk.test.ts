import { mkdirSync } from "node:fs";
import { join } from "node:path";
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

// A real orchestrator session hands a worker a directory it owns (a worktree)
// through subagent_start's cwd, then resumes the worker there.
it("runs a tool-spawned child in the caller's cwd and keeps it resumable", async () => {
  const dir = offlineAgentDir({ extensions: [EXTENSIONS.subagent, EXTENSIONS.lifecycleRecorder] });
  const lifecycle = lifecycleLog();
  const { session: orchestrator, faux } = await realChildSession(dir, {
    type: "orchestrate",
    provider: "cwd-test",
  });
  const worktree = join(dir, "worktrees", "feat-x");
  mkdirSync(worktree, { recursive: true });
  let workerId: string | undefined;
  let resumeResult = "";
  faux.setResponses([
    toolCall(
      "subagent_start",
      {
        subagent_type: "general-purpose",
        description: "Build feature",
        prompt: "Build the feature.",
        cwd: "worktrees/feat-x",
      },
      "call-spawn-1",
    ),
    fauxAssistantMessage("First pass done."),
    (context) => {
      const result = lastResult(context, "subagent_start");
      workerId = agentIdIn(result);
      return toolCall(
        "subagent_start",
        {
          subagent_type: "general-purpose",
          description: "Build feature",
          prompt: "Add the tests.",
          resume: workerId ?? "",
        },
        "call-resume-1",
      );
    },
    fauxAssistantMessage("Tests added."),
    (context) => {
      const result = lastResult(context, "subagent_start");
      resumeResult = result;
      return fauxAssistantMessage("Delegated.");
    },
  ]);

  await orchestrator.runTurnLoop("Delegate the feature.", {});
  expect(workerId).toBeTruthy();
  expect(resumeResult).toContain("Tests added.");
  expect(resumeResult).not.toContain("resume is unavailable");
  await orchestrator.dispose();

  const log = lifecycle();
  const created = log.filter((entry) => entry.channel === "subagent:session:created");
  expect(created).toHaveLength(1);
  expect(created[0].data).toMatchObject({ agentId: workerId, cwd: worktree });
}, 20_000);
