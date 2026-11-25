/** pi-ask: the inline question window waiting for an answer. */
import { defineScenario, text, tool } from "#scripted-model/scenario";

export default defineScenario({
  title: "queue-retries",
  replies: [
    [
      [
        text("Two decisions before I change the worker."),
        tool("ask", {
          questions: [
            {
              header: "Backoff",
              question: "How should failed jobs be retried?",
              options: [
                { label: "Exponential (Recommended)", description: "1s, 2s, 4s… capped at 5 min" },
                { label: "Fixed interval", description: "Every 30 seconds" },
                { label: "No retries", description: "Fail the job at once" },
              ],
            },
            {
              header: "Limit",
              question: "How many attempts before a job is dead-lettered?",
              options: [
                { label: "5", description: "Matches the payments service" },
                { label: "10", description: "Tolerates longer outages" },
              ],
            },
          ],
        }),
      ],
    ],
  ],
});
