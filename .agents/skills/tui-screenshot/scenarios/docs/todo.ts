/** pi-todo: tasks with dependencies, a recorded message, then the /todo browser. */
import { defineScenario, text, tool } from "#scripted-model/scenario";

export default defineScenario({
  title: "queue-retries",
  replies: [
    [
      [
        text("Planning the change."),
        tool("todo_upsert", {
          tasks: [
            { key: "survey", subject: "Survey how jobs fail today", status: "completed" },
            {
              key: "backoff",
              subject: "Add exponential backoff to the worker",
              status: "in_progress",
              dependsOn: ["survey"],
            },
            { key: "dlq", subject: "Dead-letter jobs after 5 attempts", dependsOn: ["backoff"] },
            { key: "tests", subject: "Cover retries with fake timers", dependsOn: ["backoff"] },
            { key: "docs", subject: "Document retry settings", dependsOn: ["dlq"] },
          ],
        }),
      ],
      [
        tool("todo_upsert", {
          tasks: [
            {
              key: "survey",
              subject: "Survey how jobs fail today",
              status: "completed",
              message: "Failures come from timeouts in src/queue/worker.ts; nothing retries.",
            },
          ],
        }),
      ],
      "Backoff is next; the survey's findings are on its task.",
    ],
  ],
});
