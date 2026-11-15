/**
 * A session for bb's slots: seven tasks (done, active, blocked, pending), two
 * running subagents and a stash entry. Fills the Todos and Subagents stack
 * cards, the context segment and the Pi tab.
 *
 *   node .agents/skills/bb-screenshot/scripts/bb-harness.mjs thread \
 *     --scenario .agents/skills/bb-screenshot/scenarios/bb-session.ts \
 *     --prompt "Move retries into the queue worker"
 */
import { defineScenario, startAgent, text, tool } from "#scripted-model/scenario";

export default defineScenario({
  title: "retry-queue-worker",
  replies: [
    [
      [
        text("Planning the retry work."),
        tool("todo_upsert", {
          tasks: [
            { key: "table", subject: "Add the delivery_attempts table", status: "completed" },
            { key: "backoff", subject: "Exponential backoff with jitter", status: "completed" },
            { key: "dead", subject: "Dead-letter after 8 attempts", status: "completed" },
            {
              key: "worker",
              subject: "Move retries into the queue worker",
              status: "in_progress",
              dependsOn: ["table"],
            },
            {
              key: "tests",
              subject: "Retry and dead-letter tests",
              dependsOn: ["worker"],
            },
            { key: "metrics", subject: "Emit retry metrics" },
            { key: "docs", subject: "Document the retry policy" },
          ],
        }),
      ],
      [
        tool("stash_put", {
          name: "retry-notes",
          content: "Backoff: 2^n seconds with full jitter, capped at 10 minutes.\n",
        }),
      ],
      [
        text("Delegating the worker survey and the test plan."),
        startAgent({
          type: "Explore",
          description: "Find every retry call site",
          prompt: "Find every place that retries a delivery.",
          steps: [[tool("bash", { command: "ls" })]],
        }),
        startAgent({
          type: "Plan",
          description: "Plan retry and dead-letter tests",
          prompt: "Plan tests for retries and dead-lettering.",
          steps: [[tool("read", { path: "README.md" })]],
        }),
      ],
      "Two agents are surveying the retry paths and planning tests.",
    ],
  ],
});
