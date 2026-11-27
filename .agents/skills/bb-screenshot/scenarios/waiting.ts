/**
 * A task waiting on the user: it lists on the Attention page with Reply, and a
 * reply wakes the thread, which answers with the scenario's second reply.
 *
 *   node .agents/skills/bb-screenshot/scripts/bb-harness.mjs thread \
 *     --scenario .agents/skills/bb-screenshot/scenarios/waiting.ts \
 *     --prompt "Plan the dead-letter queue"
 */
import { defineScenario, tool } from "#scripted-model/scenario";

export default defineScenario({
  title: "dead-letter-queue",
  replies: [
    [
      [
        tool("todo_upsert", {
          tasks: [
            {
              key: "limit",
              subject: "Pick the dead-letter attempt limit",
              status: "waiting",
              message: "Set QUEUE_MAX_ATTEMPTS in .env.staging: 5 or 8?",
            },
            { key: "dlq", subject: "Dead-letter jobs", dependsOn: ["limit"] },
          ],
        }),
      ],
      "The attempt limit is yours to pick; reply on the task.",
    ],
    // The user's reply starts this turn.
    ["Thanks, using that limit."],
  ],
});
