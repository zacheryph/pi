/**
 * A finished background job wakes an idle session: its completion message
 * starts the next turn, once (pi-job through pi-work's root host).
 */
import { expect, it } from "vitest";
import {
  customMessages,
  defineScenario,
  onlyRun,
  session,
  textOf,
  untilMessages,
  tool,
} from "#test/support/session";

it("starts the next turn with the job's completion message", async () => {
  const pi = await session({
    scenario: defineScenario({
      replies: [
        [[tool("job_start", { command: "echo job-output-42", timeoutSeconds: 30 })], "Waiting."],
        // The completion message starts the next turn.
        ["The job finished."],
      ],
    }),
  });

  await pi.prompt("Run it in the background");
  expect(onlyRun(pi, "job_start").text).toMatch(/^Started job j1 /);
  await untilMessages(pi, "job:completion");

  const [completion] = customMessages(pi, "job:completion");
  expect(completion).toMatch(/^Job j1 succeeded: echo job-output-42/);
  expect(completion).toContain("job-output-42");
  // The model was asked once more, on a context that ends with the completion.
  const woken = pi
    .requests()
    .filter((request) =>
      request.messages.some((m) => m.role === "custom" && m.customType === "job:completion"),
    );
  expect(woken).toHaveLength(1);
  const last = woken[0]!.messages
    .filter((m) => m.role !== "custom" || m.customType === "job:completion")
    .at(-1);
  expect(last).toMatchObject({ role: "custom", customType: "job:completion" });
  const replies = pi.session.messages.filter((m) => m.role === "assistant").map(textOf);
  expect(replies.at(-1)).toBe("The job finished.");
});
