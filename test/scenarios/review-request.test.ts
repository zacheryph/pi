/**
 * A pull request handed to the user for review is listed by `/attention`
 * (pi-attention, reading pi-git's `git.attention` view through pi-surface)
 * until the facts pi-git reads say it is dealt with: green checks alone list
 * nothing, a request lists one item, a retry adds nothing, a push makes it
 * stale, a request at the new head makes it ready again, marking it ready for
 * review resolves it, and a resume keeps each of those.
 */
import { expect, it } from "vitest";
import { customMessages, defineScenario, runsOf, session, tool } from "#test/support/session";
import { fakeGh } from "#test/support/gh";

const PR = "https://github.com/acme/api/pull/12";
const A = "a13c90e".padEnd(40, "0");
const B = "b24d01f".padEnd(40, "1");
const view = (head: string, isDraft = true) => ({
  number: 12,
  url: PR,
  title: "Add login",
  state: "OPEN",
  isDraft,
  reviewDecision: "REVIEW_REQUIRED",
  mergeable: "MERGEABLE",
  headRefName: "feat/login",
  headRefOid: head,
  statusCheckRollup: [
    { __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
  comments: [],
  reviews: [],
});
const status = tool("git_pr_status", { pr: PR });
const request = (head: string) =>
  tool("git_pr_request_review", { pr: PR, head, reason: "Step 2: login form" });

it("lists a requested review until it is dealt with, across a push and a resume", async () => {
  const gh = fakeGh(view(A));
  const pi = await session({
    scenario: defineScenario({
      replies: [],
      prompts: {
        "CI is green": [[status], "Green."],
        "Hand it off": [[request(A)], [request(A)], "Handed off."],
        "It was pushed to": [[status], "Head moved."],
        "Hand it off again": [[request(B)], "Handed off again."],
        "Check it": [[status], "Checked."],
      },
    }),
  });
  /** What `/attention` prints outside the terminal, as a fresh line each time. */
  const attention = async () => {
    await pi.prompt("/attention");
    return customMessages(pi, "attention").at(-1)!;
  };

  // Green checks and no handoff: nothing waits on the user.
  await pi.prompt("CI is green");
  expect(await attention()).toBe("Nothing needs you in this session.");

  await pi.prompt("Hand it off");
  const [first, retry] = runsOf(pi, "git_pr_request_review");
  expect(first!.text).toMatch(/^Requested review of acme\/api#12 at a13c90e00000\. /);
  // No watch runs here, so the result says how to keep the request current.
  expect(first!.text).toContain(`call git_pr_watch { pr: "${PR}", until: "merged" }`);
  expect(retry!.text).toMatch(/is already requested; nothing recorded\./);
  expect(pi.entries("git:attention")).toHaveLength(1);
  const listed = await attention();
  expect(listed).toMatch(/^Needs you · this session\n◆ Review acme\/api#12 · Ready\n/);
  expect(listed).toContain("Step 2: login form · draft at a13c90e");
  expect(listed).toContain(PR);

  // A push: stale, still listed, until it is requested again at the new head.
  gh.answer(view(B));
  await pi.prompt("It was pushed to");
  expect(await attention()).toMatch(/\n◇ Review acme\/api#12 · Stale\n.*new commits since a13c90e/);
  await pi.prompt("Hand it off again");
  expect(runsOf(pi, "git_pr_request_review").at(-1)!.text).toContain(
    "(the request at a13c90e00000 was stale)",
  );

  // A resume replays the same request.
  await pi.resume();
  expect(await attention()).toMatch(/\n◆ Review acme\/api#12 · Ready\n.*draft at b24d01f/);

  // Marked ready for review: dealt with, and still so after another resume.
  gh.answer(view(B, false));
  await pi.prompt("Check it");
  expect(await attention()).toBe("Nothing needs you in this session.");
  await pi.resume();
  expect(await attention()).toBe("Nothing needs you in this session.");
  expect(pi.extensionErrors).toEqual([]);
});
