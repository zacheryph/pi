/** pi-dashboard: a session with tasks, a stash entry, two agents and an open question. */
import { defineScenario, startAgent, text, tool } from "#scripted-model/scenario";

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
        tool("stash_put", {
          name: "queue-failures",
          description: "Every place a queued job can fail",
          content:
            "src/queue/worker.ts:12  retry() calls job() once\nsrc/queue/dispatch.ts:8  failed jobs are dropped",
        }),
      ],
      [
        startAgent({
          type: "Explore",
          description: "Find every queue consumer",
          prompt: "List every module that consumes the job queue.",
          steps: [[tool("bash", { command: "ls src" })]],
        }),
        startAgent({
          type: "general-purpose",
          description: "Write failing-job tests",
          prompt: "Write tests that cover a job failing and being retried.",
          steps: [[tool("bash", { command: "ls test" })]],
        }),
      ],
      [
        tool("ask", {
          questions: [
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
