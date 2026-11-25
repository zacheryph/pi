/** pi-tldr: a session with some history, then its /tldr recap. */
import { defineScenario, text, tool } from "#scripted-model/scenario";

export default defineScenario({
  title: "queue-retries",
  recap: {
    premise: "Make failed queue jobs retry instead of being dropped",
    findings:
      "Timeouts in the worker were the main failure; dispatch dropped failed jobs; no test covered a failing job",
    status: "Backoff implemented and tested; dead-letter queue still pending",
  },
  replies: [
    [
      [text("Reading the worker first."), tool("read", { path: "src/queue/worker.ts" })],
      "The worker calls each job once and drops it on failure. I'll add backoff next.",
    ],
  ],
});
