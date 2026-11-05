/**
 * Todos and Subagents widgets, both open: five tasks with dependencies and two
 * background agents still running.
 *
 *   node .agents/skills/tui-screenshot/scripts/screenshot.mjs \
 *     --scenario .agents/skills/tui-screenshot/scenarios/todo-subagent.ts \
 *     --prompt "Audit the TUI widget padding and add tests" \
 *     --wait-for "2 running agents" --out todo-subagent.png
 */
import {
  defineScenario,
  startAgent,
  text,
  tool,
} from "../../../../packages/pi-scripted-model/src/scenario.ts";

export default defineScenario({
  title: "widget-padding-audit",
  replies: [
    [
      [
        text("I'll plan this out first."),
        tool("todo_upsert", {
          tasks: [
            { key: "survey", subject: "Survey extension widget rendering", status: "completed" },
            {
              key: "audit",
              subject: "Audit widget padding at narrow widths",
              status: "in_progress",
              dependsOn: ["survey"],
            },
            {
              key: "tests",
              subject: "Add ANSI and wide-Unicode rendering tests",
              dependsOn: ["audit"],
            },
            { key: "docs", subject: "Document the shared inset convention", dependsOn: ["audit"] },
            {
              key: "verify",
              subject: "Run npm run check and the full test suite",
              dependsOn: ["tests", "docs"],
            },
          ],
        }),
      ],
      [
        text("Delegating the audit and the test plan."),
        startAgent({
          type: "general-purpose",
          description: "Audit widget padding",
          prompt: "Audit every widget's horizontal padding at narrow widths.",
          steps: [[tool("read", { path: "AGENTS.md" })]],
        }),
        startAgent({
          type: "Plan",
          description: "Plan rendering tests",
          prompt: "Plan rendering tests for ANSI and wide Unicode text.",
          steps: [[tool("bash", { command: "ls extensions" })]],
        }),
      ],
      "Two agents are working on the audit and the test plan. I'll pick up their results when they finish.",
    ],
  ],
});
