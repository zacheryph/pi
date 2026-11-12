/**
 * A subagent's stash entry is adopted by its parent: it shows in the parent's
 * list, and its handle reads there (pi-stash `adopt`/`passUp` across pi-subagent).
 */
import { expect, it } from "vitest";
import {
  capture,
  childRuns,
  customMessages,
  defineScenario,
  onlyRun,
  session,
  startAgent,
  tool,
  untilMessages,
} from "#test/support/session";

it("adopts a subagent's stash entry into the parent's list", async () => {
  const pi = await session({
    scenario: defineScenario({
      replies: [
        [
          [
            startAgent({
              type: "general-purpose",
              description: "Collect findings",
              prompt: "Collect the findings, stash them, and report the handle.",
              steps: [
                [
                  tool("stash_put", {
                    name: "findings",
                    description: "What the child found",
                    content: "first finding\nsecond finding\n",
                  }),
                ],
                "Stashed the findings.",
              ],
            }),
          ],
          "Started.",
        ],
        // The completion message starts the next turn.
        [
          [tool("stash_list", {})],
          [tool("stash_get", { ref: "findings", grep: { pattern: "second" } })],
          "Read them.",
        ],
      ],
    }),
  });

  await pi.prompt("Find things");
  await untilMessages(pi, "subagent:completion");
  const [put] = childRuns(customMessages(pi, "subagent:completion")[0]!);
  expect(put?.name).toBe("stash_put");
  expect(put?.isError, put?.text).toBe(false);
  const handle = capture(put!.text, /^Stashed (stash:findings@\w+)/);

  const list = onlyRun(pi, "stash_list");
  expect(list.text).toContain(handle);
  expect(list.text).toMatch(/by agent \w+/);
  const get = onlyRun(pi, "stash_get");
  expect(get.text).toContain(handle);
  expect(get.text).toContain("second finding");
  expect(get.text).not.toContain("first finding");
});
