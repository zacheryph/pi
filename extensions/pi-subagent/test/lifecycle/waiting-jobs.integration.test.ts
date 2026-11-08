import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  fauxSession,
  toolCall,
  type FauxSession,
} from "../../../../packages/pi-test-helpers/src/faux-session.ts";
import { tempDir } from "../../../../packages/pi-test-helpers/src/temp.ts";
import { waitFor } from "../../../../packages/pi-test-helpers/src/wait.ts";
import { createJobsExtension } from "../../../pi-job/src/extension.ts";
import { provide } from "../../../../packages/pi-session-tree/src/index.ts";
import { ACTIVATION_SERVICE } from "../../../../packages/pi-session-tree/src/activation.ts";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { SubagentManager } from "#src/lifecycle/subagent-manager";
import { SubagentSession } from "#src/lifecycle/subagent-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { createChildLifecycleMock } from "#test/helpers/subagent-session-io";

it("parks a real child AgentSession for job_watch and observes its managed completion", async () => {
  const dir = tempDir(onTestFinished, "pi-waiting-job-");
  const gate = join(dir, "ci-finished");
  let child!: FauxSession;
  const manager = new SubagentManager({
    registry: new AgentTypeRegistry(() => new Map()),
    limiter: new ConcurrencyLimiter(() => 1),
    createSubagentSession: async (params) => {
      const sessions = SessionManager.inMemory(dir);
      const sessionId = sessions.getSessionId();
      const withdraw = provide(sessionId, ACTIVATION_SERVICE, params.activation!);
      onTestFinished(withdraw);
      child = await fauxSession({
        cleanup: onTestFinished,
        dir,
        sessionManager: sessions,
        provider: "waiting-worker-integration",
        models: [{ id: "worker" }],
        extensions: [createJobsExtension({ logRoot: join(dir, "logs"), minIntervalSeconds: 0.1 })],
        session: { noTools: "builtin", thinkingLevel: "off" },
        responses: [
          toolCall("job_watch", {
            check: `test -f '${gate}'`,
            intervalSeconds: 0.1,
            timeoutSeconds: 20,
            label: "CI checks",
          }),
          fauxAssistantMessage("Waiting for CI."),
          fauxAssistantMessage("CI passed; review complete."),
        ],
      });
      return new SubagentSession(child.session, {
        sessionId,
        sessionDir: dir,
        outputFile: undefined,
        agentName: "general-purpose",
        agentMaxTurns: 10,
        parentContext: undefined,
        lifecycle: createChildLifecycleMock(),
        onDispose: withdraw,
      });
    },
  });
  try {
    const id = manager.spawn(
      STUB_SNAPSHOT,
      "general-purpose",
      "Watch CI, then finish your review.",
      { description: "Review CI", background: true },
    );
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(record.status).toBe("waiting");
    expect(record.waitingReason).toContain("CI checks");
    const toolsBefore = record.toolUses;
    writeFileSync(gate, "");
    await waitFor(() => record.status === "completed", { what: "managed watch completion" });
    expect(record.result).toBe("CI passed; review complete.");
    expect(child.requests).toHaveLength(3);
    expect(JSON.stringify(child.requests.at(-1))).toContain("Watch j1 matched: CI checks");
    expect(child.errors).toEqual([]);
    expect(record.toolUses).toBe(toolsBefore);
    expect(record.lifetimeUsage.output).toBeGreaterThan(0);
    expect(record.turnBudget?.used).toBe(1);
  } finally {
    manager.abortAll();
    await manager.dispose();
  }
}, 15000);
