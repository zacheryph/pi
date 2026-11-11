/**
 * A subagent's `ask` reaches its parent agent once; the parent answers with
 * subagent_send and the child resumes with the answer (pi-ask through pi-work's
 * parent link and question item, across pi-subagent).
 */
import { expect, it } from "vitest";
import {
  agentId,
  capture,
  childRuns,
  customMessages,
  defineScenario,
  onlyRun,
  session,
  startAgent,
  textOf,
  tool,
  untilMessages,
} from "../support/session.ts";

it("tells the parent once and resumes the child with its answer", async () => {
  const pi = await session({
    scenario: defineScenario({
      replies: [
        [
          [
            startAgent({
              type: "general-purpose",
              description: "Pick a colour",
              prompt: "Ask which colour to use, then report it.",
              steps: [
                [
                  tool("ask", {
                    questions: [
                      {
                        question: "Which colour?",
                        options: [{ label: "red" }, { label: "blue" }],
                      },
                    ],
                  }),
                ],
                // The answer is the child's next prompt.
                (messages) => `Using ${textOf(messages.findLast((m) => m.role === "user"))}.`,
              ],
            }),
          ],
          "Started.",
        ],
        // The question starts the next turn.
        [
          (messages) => [
            tool("subagent_send", {
              agent_id: capture(textOf(messages.at(-1)), /agent_id: "([^"]+)"/),
              message: "blue",
            }),
          ],
          "Answered.",
        ],
        // The child's completion starts the third.
        ["Noted."],
      ],
    }),
  });

  await pi.prompt("Pick a colour with a subagent");
  const id = agentId(onlyRun(pi, "subagent_start").text);
  await untilMessages(pi, "subagent:completion");

  const questions = customMessages(pi, "subagent:question");
  expect(questions).toHaveLength(1);
  expect(questions[0]).toContain(`<task-id>${id}</task-id>`);
  expect(questions[0]).toContain("Which colour?");
  expect(onlyRun(pi, "subagent_send").args).toEqual({ agent_id: id, message: "blue" });

  const [completion] = customMessages(pi, "subagent:completion");
  expect(completion).toContain("<result>Using blue.</result>");
  const [ask] = childRuns(completion!);
  expect(ask).toMatchObject({ name: "ask", isError: false, details: { route: "parent" } });
});
