/** pi-job: a background job the agent waits on without polling. */
import { defineScenario, text, tool } from "#scripted-model/scenario";

export default defineScenario({
  title: "queue-retries",
  replies: [
    [
      [
        text("Running the suite in the background."),
        tool("job_start", {
          command: "sleep 2; echo 'Test Files  12 passed (12)'; echo 'Tests  148 passed (148)'",
          timeoutSeconds: 600,
          label: "test suite",
        }),
      ],
      "The suite is running. I'll pick it up when it finishes.",
    ],
    // The job's completion message starts this turn.
    ["All 148 tests pass. Ready for review."],
  ],
});
