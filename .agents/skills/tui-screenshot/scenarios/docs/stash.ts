/** pi-stash: a large result stored as a handle, then the /stash browser. */
import { defineScenario, text, tool } from "#scripted-model/scenario";

const findings = [
  "src/queue/worker.ts:12  retry() calls job() once; no backoff",
  "src/queue/worker.ts:31  timeouts surface as generic Error",
  "src/queue/dispatch.ts:8  failed jobs are dropped, not re-queued",
  "src/auth/token.ts:4  verify() accepts any non-empty token",
  "test/worker.test.ts  no test covers a failing job",
  ...Array.from(
    { length: 140 },
    (_, i) => `src/orders/handler-${i}.ts  awaits queue.push() without catch`,
  ),
].join("\n");

export default defineScenario({
  title: "queue-retries",
  replies: [
    [
      [
        text("The survey is long, so I'll keep it out of context."),
        tool("stash_put", {
          name: "queue-failures",
          description: "Every place a queued job can fail, with file and line",
          content: findings,
        }),
      ],
      [tool("stash_get", { ref: "queue-failures", grep: { pattern: "worker" } })],
      "Stored the survey as a handle; the worker has two failure points.",
    ],
  ],
});
