/** pi-todo: tasks with dependencies, a recorded message, one waiting on the user, then the /todo browser. */
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
            {
              key: "limit",
              subject: "Pick the dead-letter attempt limit",
              status: "waiting",
              message: "Set QUEUE_MAX_ATTEMPTS in .env.staging: 5 or 8?",
            },
          ],
        }),
      ],
      "Backoff is next; the survey's findings are on its task, and the attempt limit is yours to pick.",
    ],
  ],
});
