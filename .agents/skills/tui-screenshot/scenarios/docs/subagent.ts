/** pi-subagent: three background agents in the widget and the watch overlay. */
import { defineScenario, startAgent, text, tool } from "#scripted-model/scenario";

export default defineScenario({
  title: "queue-retries",
  replies: [
    [
      [
        text("Splitting this three ways."),
        startAgent({
          type: "Explore",
          description: "Find every queue consumer",
          prompt: "List every module that consumes the job queue.",
          steps: [
            [text("Searching for queue consumers."), tool("bash", { command: "ls src" })],
            [tool("read", { path: "src/queue/worker.ts" })],
          ],
        }),
        startAgent({
          type: "Plan",
          description: "Plan the retry policy",
          prompt: "Plan an exponential backoff policy for the worker.",
          steps: [
            [text("Reading the worker before planning."), tool("read", { path: "README.md" })],
          ],
        }),
        startAgent({
          type: "general-purpose",
          description: "Write failing-job tests",
          prompt: "Write tests that cover a job failing and being retried.",
          steps: [[tool("bash", { command: "ls test" })]],
        }),
      ],
      "Three agents are on it; I'll combine their results.",
    ],
  ],
});
