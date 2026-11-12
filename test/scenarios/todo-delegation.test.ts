/**
 * A task handed to a subagent: the child sees and updates only that task, its
 * updates land in the parent's list, and only the parent completes it
 * (pi-todo's delegation broker and claims, across pi-subagent).
 */
import { expect, it } from "vitest";
import {
  childRuns,
  customMessages,
  defineScenario,
  onlyRun,
  runsOf,
  session,
  startAgent,
  tool,
  untilMessages,
} from "#test/support/session";

it("hands a task to a subagent, sees its update and completes it in the parent", async () => {
  const pi = await session({
    scenario: defineScenario({
      replies: [
        [
          [
            tool("todo_upsert", {
              tasks: [
                { key: "impl", subject: "Implement it" },
                { key: "docs", subject: "Document it" },
              ],
            }),
          ],
          [
            startAgent({
              type: "general-purpose",
              description: "Implement it",
              prompt: "Implement the impl task and report the outcome for parent acceptance.",
              options: { handoff: { todo: { keys: ["impl"] } } },
              steps: [
                // Only the parent may complete a handed-off task.
                [tool("todo_upsert", { tasks: [{ key: "impl", status: "completed" }] })],
                [
                  tool("todo_upsert", {
                    tasks: [{ key: "impl", status: "in_progress", message: "Implemented." }],
                  }),
                ],
                // Another task is not the child's to touch.
                [tool("todo_upsert", { tasks: [{ key: "docs", status: "in_progress" }] })],
                [tool("todo_list", {})],
                "Implemented.",
              ],
            }),
          ],
          "Started.",
        ],
        // The completion message starts the next turn.
        [
          [tool("todo_list", { key: "impl" })],
          [
            tool("todo_upsert", {
              tasks: [{ key: "impl", status: "completed", message: "Verified and accepted." }],
            }),
          ],
          [tool("todo_list", {})],
          "All done.",
        ],
      ],
    }),
  });

  await pi.prompt("Do the work");
  onlyRun(pi, "subagent_start");
  await untilMessages(pi, "subagent:completion");
  const [completion] = customMessages(pi, "subagent:completion");
  expect(completion).toContain("<result>Implemented.</result>");

  // The child's broker enforced the claim: it could not complete its task or
  // touch another, and its list held only the task it was handed.
  const child = childRuns(completion!);
  expect(child.map((run) => [run.name, run.isError])).toEqual([
    ["todo_upsert", true],
    ["todo_upsert", false],
    ["todo_upsert", true],
    ["todo_list", false],
  ]);
  const childList = JSON.parse(child[3]!.text) as { tasks: { key: string }[] };
  expect(childList.tasks.map((task) => task.key)).toEqual(["impl"]);

  // The parent sees the child's update, attributed to the child.
  const [detail, all] = runsOf(pi, "todo_list");
  expect(detail?.isError, detail?.text).toBe(false);
  expect(JSON.parse(detail!.text).tasks).toMatchObject([
    {
      key: "impl",
      subject: "Implement it",
      status: "in_progress",
      updates: expect.arrayContaining([
        expect.objectContaining({
          status: "in_progress",
          message: "Implemented.",
          agent: expect.any(String),
        }),
      ]),
    },
  ]);
  // The parent accepted it; the other task is untouched.
  expect(all?.isError, all?.text).toBe(false);
  expect(JSON.parse(all!.text).tasks).toEqual([
    {
      key: "impl",
      subject: "Implement it",
      status: "completed",
      lastMessage: "Verified and accepted.",
    },
    { key: "docs", subject: "Document it", status: "pending" },
  ]);
});
