/**
 * A watched pull request wakes the session that waits on it: `git_pr_watch`
 * opens an item in the session's work host, the turn ends, and the report that
 * checks finished starts the next one (pi-git through pi-work's root host, and
 * through a subagent's managed host).
 */
import { expect, it } from "vitest";
import {
  childRuns,
  customMessages,
  defineScenario,
  onlyRun,
  session,
  startAgent,
  textOf,
  tool,
  untilMessages,
} from "#test/support/session";
import { fakeGh } from "#test/support/gh";

const PR = "https://github.com/acme/api/pull/12";
const view = (checks: object[]) => ({
  number: 12,
  url: PR,
  title: "Add login",
  state: "OPEN",
  isDraft: false,
  reviewDecision: "",
  mergeable: "MERGEABLE",
  headRefName: "feat/login",
  headRefOid: "1a2b3c4d5e6f7a8b",
  statusCheckRollup: checks,
  comments: [],
  reviews: [],
});
const running = view([{ __typename: "CheckRun", name: "unit", status: "IN_PROGRESS" }]);
const failed = view([
  { __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "FAILURE" },
  { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
]);
// The shortest interval the setting allows.
const agentFiles = { "git.json": { watchIntervalSeconds: 5 } };
const REPORT = [
  "Pull request acme/api#12:",
  "Checks finished on head 1a2b3c4d5e6f: 1 failed (unit), 1 passed.",
  "The watch has ended.",
  PR,
].join("\n");

it("ends the turn after git_pr_watch and starts the next with its report", async () => {
  const gh = fakeGh(running);
  const pi = await session({
    agentFiles,
    scenario: defineScenario({
      replies: [
        [[tool("git_pr_watch", { pr: PR })], "Waiting for CI."],
        // The watch's report starts the next turn.
        [[tool("git_pr_list", {})], "CI failed on unit."],
      ],
    }),
  });

  await pi.prompt("Get the PR green");
  expect(onlyRun(pi, "git_pr_watch").text).toMatch(
    /^Now watching until checks finish on its head \(120m left\)\. End your turn/,
  );
  expect(customMessages(pi, "git:pr-watch")).toEqual([]);

  gh.answer(failed);
  await untilMessages(pi, "git:pr-watch");
  expect(customMessages(pi, "git:pr-watch")).toEqual([REPORT]);
  // The model was asked once more, on a context that ends with the report.
  const woken = pi
    .requests()
    .filter((request) =>
      request.messages.some((m) => m.role === "custom" && m.customType === "git:pr-watch"),
    );
  expect(
    woken[0]!.messages.filter((m) => m.role !== "custom" || m.customType === "git:pr-watch").at(-1),
  ).toMatchObject({
    role: "custom",
    customType: "git:pr-watch",
  });
  const replies = pi.session.messages.filter((m) => m.role === "assistant").map(textOf);
  expect(replies.at(-1)).toBe("CI failed on unit.");
  // The watch ended with its report, and the ledger holds what it last read.
  const list = onlyRun(pi, "git_pr_list").text;
  expect(list).toContain("checks 1 failed, 1 passed");
  expect(list).not.toContain("watching until");
});

it("keeps a subagent waiting on its watch and wakes it with the report", async () => {
  const gh = fakeGh(running);
  const pi = await session({
    agentFiles,
    scenario: defineScenario({
      replies: [
        [
          [
            startAgent({
              type: "general-purpose",
              description: "Babysit the PR",
              prompt: "Wait for CI on the pull request and report the result.",
              steps: [
                [tool("git_pr_watch", { pr: PR })],
                "Waiting for CI.",
                // The watch's report is the child's next turn.
                (messages) =>
                  messages.some((m) =>
                    /Checks finished on head 1a2b3c4d5e6f: 1 failed \(unit\)/.test(textOf(m)),
                  )
                    ? "unit failed."
                    : "unknown.",
              ],
            }),
          ],
          "Started.",
        ],
        // The child's completion starts the next turn.
        ["Noted."],
      ],
    }),
  });

  await pi.prompt("Have a subagent watch the PR");
  // The child ended its turn, but its open watch keeps it from completing.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(customMessages(pi, "subagent:completion")).toEqual([]);

  gh.answer(failed);
  await untilMessages(pi, "subagent:completion");
  const [completion] = customMessages(pi, "subagent:completion");
  expect(completion).toContain("<result>unit failed.</result>");
  const [watch] = childRuns(completion!);
  expect(watch).toMatchObject({ name: "git_pr_watch", isError: false });
  // The PR the child watched was handed up to this session's ledger.
  expect(pi.entries()).toContainEqual(
    expect.objectContaining({
      type: "custom",
      customType: "git:ledger",
      data: expect.objectContaining({ kind: "pr", key: "github.com/acme/api#12" }),
    }),
  );
});
