import { describe, expect, it, vi } from "vitest";
import { observe, parsePrUrls, parseRemote, type ToolResultLike } from "../src/observe.ts";
import { mergeStatus, observedStatus } from "../src/prs.ts";

const text = (value: string) => [{ type: "text", text: value }];
const result = (
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  isError = false,
) => ({ toolName, input, content: text(output), isError }) satisfies ToolResultLike;
const bash = (command: string, output: string, isError = false) =>
  result("bash", { command }, output, isError);

const ORIGIN = { host: "github.com", owner: "acme", repo: "api" };
const resolveRepo = vi.fn(async () => ORIGIN);
const run = (tool: ToolResultLike, cwd = "/work/api") => observe(tool, { cwd, resolveRepo });

/** `gh pr view` prints `key:\tvalue` lines when its output is not a terminal. */
const PLAIN_VIEW = [
  "title:\tAdd login",
  "state:\tDRAFT",
  "author:\toctocat",
  "number:\t12",
  "url:\thttps://github.com/acme/api/pull/12",
  "--",
  "Body mentions https://github.com/acme/other/pull/99",
].join("\n");

const VIEW_JSON = JSON.stringify({
  number: 12,
  url: "https://github.com/acme/api/pull/12",
  title: "Add login",
  state: "OPEN",
  isDraft: false,
  reviewDecision: "CHANGES_REQUESTED",
  mergeable: "CONFLICTING",
  headRefName: "feat/login",
  headRefOid: "abc123",
  statusCheckRollup: [
    { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" },
    { __typename: "StatusContext", state: "SUCCESS" },
  ],
});

/** `gh pr checks` rows: name, bucket, elapsed, link, description. */
const CHECKS_ROWS = [
  "lint\tpass\t32s\thttps://github.com/acme/api/actions/runs/1/job/11\t",
  "test\tfail\t1m2s\thttps://github.com/acme/api/actions/runs/1/job/12\t",
  "deploy\tpending\t0\thttps://github.com/acme/api/actions/runs/1/job/13\t",
  "docs\tskipping\t0\thttps://github.com/acme/api/actions/runs/1/job/14\t",
].join("\n");

const REST_PR = JSON.stringify({
  number: 7,
  html_url: "https://github.com/acme/web/pull/7",
  title: "Fix nav",
  state: "closed",
  merged: true,
  draft: false,
  mergeable: null,
  head: { ref: "fix/nav", sha: "def456" },
});

describe("observe: gh in a shell", () => {
  it.each([
    {
      name: "gh pr create: the printed URL, opened here",
      tool: bash(
        "gh pr create --title 'Add login' --body x --draft",
        "Warning: 1 uncommitted change\nhttps://github.com/acme/api/pull/12\n",
      ),
      expected: [
        {
          ref: { ...ORIGIN, number: 12 },
          url: "https://github.com/acme/api/pull/12",
          origin: "created",
          facts: { state: "open", draft: true },
        },
      ],
    },
    {
      name: "gh pr view <n>: plain output gives state, draft and title",
      tool: bash("gh pr view 12", PLAIN_VIEW),
      expected: [
        {
          ref: { ...ORIGIN, number: 12 },
          url: "https://github.com/acme/api/pull/12",
          origin: "referenced",
          title: "Add login",
          facts: { state: "open", draft: true },
        },
      ],
    },
    {
      name: "gh pr view (current branch) --json: everything it asked for",
      tool: bash("gh pr view --json number,url,title,state,isDraft,reviewDecision", VIEW_JSON),
      expected: [
        {
          ref: { ...ORIGIN, number: 12 },
          url: "https://github.com/acme/api/pull/12",
          origin: "referenced",
          title: "Add login",
          facts: {
            state: "open",
            draft: false,
            review: "changes_requested",
            mergeable: false,
            headRef: "feat/login",
            headSha: "abc123",
            checks: { passed: 2, failed: 1, pending: 1 },
          },
        },
      ],
    },
    {
      name: "gh pr checks <n>: repository from the run links, counts from the rows",
      tool: bash("gh pr checks 12", CHECKS_ROWS),
      expected: [
        {
          ref: { ...ORIGIN, number: 12 },
          url: "https://github.com/acme/api/pull/12",
          origin: "referenced",
          facts: { checks: { passed: 2, failed: 1, pending: 1 } },
        },
      ],
    },
    {
      name: "gh pr checks --json bucket, repository from -R",
      tool: bash(
        "gh pr checks 3 -R acme/web --json name,bucket",
        JSON.stringify([
          { name: "a", bucket: "pass" },
          { name: "b", bucket: "cancel" },
        ]),
      ),
      expected: [
        {
          ref: { host: "github.com", owner: "acme", repo: "web", number: 3 },
          url: "https://github.com/acme/web/pull/3",
          origin: "referenced",
          facts: { checks: { passed: 1, failed: 1, pending: 0 } },
        },
      ],
    },
    {
      name: "gh pr merge: merged when gh says so",
      tool: bash(
        "gh pr merge 12 --squash --repo github.example.com/acme/api",
        "✓ Squashed and merged pull request acme/api#12 (Add login)",
      ),
      expected: [
        {
          ref: { host: "github.example.com", owner: "acme", repo: "api", number: 12 },
          url: "https://github.example.com/acme/api/pull/12",
          origin: "referenced",
          facts: { state: "merged" },
        },
      ],
    },
    {
      name: "gh pr merge --auto: recorded, but not merged yet",
      tool: bash(
        "gh pr merge 12 --auto --squash",
        "✓ Pull request acme/api#12 will be automatically merged",
      ),
      expected: [
        {
          ref: { ...ORIGIN, number: 12 },
          url: "https://github.com/acme/api/pull/12",
          origin: "referenced",
        },
      ],
    },
    {
      name: "a PR URL as the argument",
      tool: bash(
        "gh pr review https://github.com/acme/web/pull/4 --approve",
        "✓ Approved pull request",
      ),
      expected: [
        {
          ref: { host: "github.com", owner: "acme", repo: "web", number: 4 },
          url: "https://github.com/acme/web/pull/4",
          origin: "referenced",
        },
      ],
    },
    {
      name: "gh api repos/…/pulls/<n>: REST fields",
      tool: bash("gh api repos/acme/web/pulls/7", REST_PR),
      expected: [
        {
          ref: { host: "github.com", owner: "acme", repo: "web", number: 7 },
          url: "https://github.com/acme/web/pull/7",
          origin: "referenced",
          title: "Fix nav",
          facts: { state: "merged", draft: false, headRef: "fix/nav", headSha: "def456" },
        },
      ],
    },
    {
      name: "gh api …/pulls/<n>/reviews: the latest review per reviewer",
      tool: bash(
        "gh api repos/acme/web/pulls/7/reviews",
        JSON.stringify([
          { user: { login: "a" }, state: "CHANGES_REQUESTED", submitted_at: "1" },
          { user: { login: "a" }, state: "APPROVED", submitted_at: "2" },
          { user: { login: "b" }, state: "COMMENTED", submitted_at: "3" },
        ]),
      ),
      expected: [
        {
          ref: { host: "github.com", owner: "acme", repo: "web", number: 7 },
          url: "https://github.com/acme/web/pull/7",
          origin: "referenced",
          facts: { review: "approved" },
        },
      ],
    },
  ])("$name", async ({ tool, expected }) => {
    expect(await run(tool)).toEqual(expected);
  });

  it("does not credit one command's output to another PR in the same call", async () => {
    const output = [
      "lint\tpass\t32s\thttps://github.com/acme/api/actions/runs/1/job/11\t",
      "test\tfail\t1m2s\thttps://github.com/acme/api/actions/runs/2/job/21\t",
    ].join("\n");
    const observations = await run(
      bash("gh pr checks 69 -R acme/api; gh pr checks 70 -R acme/api", output),
    );
    expect(observations).toEqual([
      {
        ref: { ...ORIGIN, number: 69 },
        url: "https://github.com/acme/api/pull/69",
        origin: "referenced",
      },
      {
        ref: { ...ORIGIN, number: 70 },
        url: "https://github.com/acme/api/pull/70",
        origin: "referenced",
      },
    ]);
  });

  it("takes a batched gh pr create's URL only when the output holds exactly one", async () => {
    const one = await run(
      bash(
        "gh pr create --fill && gh pr checks 12 -R acme/api",
        "https://github.com/acme/api/pull/12\nlint\tpending\t0\thttps://x\t",
      ),
    );
    expect(one).toEqual([
      {
        ref: { ...ORIGIN, number: 12 },
        url: "https://github.com/acme/api/pull/12",
        origin: "created",
        // From gh pr create's own arguments, not the shared output.
        facts: { state: "open" },
      },
    ]);
    const two = await run(
      bash(
        "gh pr create --fill && gh pr view 3 -R acme/api",
        "https://github.com/acme/api/pull/12\nurl:\thttps://github.com/acme/api/pull/3",
      ),
    );
    expect(two).toEqual([
      {
        ref: { ...ORIGIN, number: 3 },
        url: "https://github.com/acme/api/pull/3",
        origin: "referenced",
      },
    ]);
  });

  it("does not infer a batched command's repository from shared output", async () => {
    resolveRepo.mockClear();
    const observations = await run(
      bash(
        "gh pr checks 5; gh pr checks 6",
        "ci\tpass\t1s\thttps://github.com/other/thing/actions/runs/1\t",
      ),
    );
    expect(observations.map((o) => o.ref)).toEqual([
      { ...ORIGIN, number: 5 },
      { ...ORIGIN, number: 6 },
    ]);
    expect(resolveRepo).toHaveBeenCalled();
  });

  it("records an explicit no-decision review when every decision was dismissed", async () => {
    const [observation] = await run(
      bash(
        "gh api repos/acme/api/pulls/69/reviews",
        JSON.stringify([
          { user: { login: "alice" }, state: "DISMISSED", submitted_at: "2" },
          { user: { login: "bob" }, state: "COMMENTED", submitted_at: "3" },
        ]),
      ),
    );
    expect(observation?.facts).toEqual({ review: "none" });
    const [empty] = await run(bash("gh api repos/acme/api/pulls/69/reviews", "[]"));
    expect(empty?.facts).toEqual({ review: "none" });
    const [viewed] = await run(
      bash("gh pr view 69 -R acme/api --json reviewDecision", '{"reviewDecision":""}'),
    );
    expect(viewed?.facts).toEqual({ review: "none" });
    const [mcp] = await run(
      result(
        "mcp__github__pull_request_read",
        { method: "get_reviews", owner: "acme", repo: "api", pullNumber: 69 },
        "[]",
      ),
    );
    expect(mcp?.facts).toEqual({ review: "none" });
  });

  it.each([
    "[]",
    JSON.stringify([
      {
        id: 321,
        user: { login: "alice" },
        body: "Please rename this variable",
        path: "src/index.ts",
        pull_request_review_id: 123,
      },
    ]),
  ])("preserves review decisions when reading inline comments: %s", async (output) => {
    const reads = [
      bash("gh api repos/acme/api/pulls/69/reviews/123/comments", output),
      bash("gh api 'repos/acme/api/pulls/69/reviews/123/comments?per_page=100'", output),
      result(
        "mcp__github__pull_request_read",
        { method: "get_review_comments", owner: "acme", repo: "api", pullNumber: 69 },
        output,
      ),
    ];
    for (const read of reads) {
      const [observation] = await run(read);
      expect(observation).toMatchObject({ ref: { ...ORIGIN, number: 69 }, origin: "referenced" });
      expect(observation?.facts?.review).toBeUndefined();
      for (const review of ["approved", "changes_requested"] as const) {
        const status = mergeStatus(
          observedStatus({ review }, 10, "bash"),
          observation?.facts ? observedStatus(observation.facts, 20, read.toolName) : undefined,
        );
        expect(status?.review).toBe(review);
      }
    }
  });

  it("resolves a bare number from the origin remote of the directory a leading cd moves to", async () => {
    resolveRepo.mockClear();
    await run(bash("cd ../web && gh pr view 5 --json state", '{"state":"OPEN"}'));
    expect(resolveRepo).toHaveBeenCalledWith("/work/api/../web");
  });

  it.each([
    ["checks failing (gh exits 1)", CHECKS_ROWS, { passed: 2, failed: 1, pending: 1 }],
    [
      "checks pending (gh exits 8)",
      "lint\tpass\t32s\thttps://github.com/acme/api/actions/runs/1/job/11\t\ndeploy\tpending\t0\thttps://github.com/acme/api/actions/runs/1/job/13\t",
      { passed: 1, failed: 0, pending: 1 },
    ],
  ])("keeps the rows of gh pr checks when %s", async (_name, output, checks) => {
    expect(
      await run(bash("gh pr checks 12", `${output}\n\nCommand exited with code 1`, true)),
    ).toEqual([
      {
        ref: { ...ORIGIN, number: 12 },
        url: "https://github.com/acme/api/pull/12",
        origin: "referenced",
        facts: { checks },
      },
    ]);
  });

  it("keeps gh pr checks --json output when a check failed", async () => {
    const json = JSON.stringify([
      { name: "a", bucket: "pass" },
      { name: "b", bucket: "fail" },
    ]);
    const [observation] = await run(
      bash("gh pr checks 12 --json name,bucket", `${json}\n\nCommand exited with code 1`, true),
    );
    expect(observation?.facts).toEqual({ checks: { passed: 1, failed: 1, pending: 0 } });
  });

  it.each([
    ["a failed command", bash("gh pr view 12", "no pull requests found", true)],
    [
      "a failed gh api read",
      bash("gh api repos/acme/web/pulls/7", '{"message":"Not Found"}', true),
    ],
    [
      "gh pr checks that failed before listing any check",
      bash("gh pr checks 12", "no checks reported on the 'feat/x' branch", true),
    ],
    [
      "gh pr checks that could not find the PR",
      bash(
        "gh pr checks 99",
        "GraphQL: Could not resolve to a PullRequest with the number of 99.",
        true,
      ),
    ],
    ["gh pr list (a listing, not a PR)", bash("gh pr list", "12\tAdd login\tfeat/login\tOPEN")],
    [
      "git log mentioning PRs",
      bash("git log --oneline", "abc Merge https://github.com/acme/api/pull/3"),
    ],
    [
      "a file that mentions PRs",
      result("read", { path: "NOTES.md" }, "see https://github.com/acme/api/pull/3"),
    ],
    ["gh pr create that printed no URL", bash("gh pr create --fill", "aborted: no commits")],
  ])("records nothing for %s", async (_name, tool) => {
    expect(await run(tool)).toEqual([]);
  });
});

describe("observe: GitHub tools", () => {
  it("records a PR the MCP server opened, from the URL it returned", async () => {
    const tool = result(
      "mcp__github__create_pull_request",
      { owner: "acme", repo: "api", title: "Add login", head: "feat/login", base: "main" },
      '{"id":"5131922131","url":"https://github.com/acme/api/pull/66"}',
    );
    expect(await run(tool)).toEqual([
      {
        ref: { ...ORIGIN, number: 66 },
        url: "https://github.com/acme/api/pull/66",
        origin: "created",
        facts: { state: "open" },
      },
    ]);
  });

  it.each([
    {
      name: "pull_request_read get: the PR object",
      tool: result(
        "mcp__github__pull_request_read",
        { method: "get", owner: "acme", repo: "web", pullNumber: 7 },
        REST_PR,
      ),
      facts: { state: "merged", draft: false, headRef: "fix/nav", headSha: "def456" },
      title: "Fix nav",
    },
    {
      name: "pull_request_read get_check_runs: counts",
      tool: result(
        "mcp__github__pull_request_read",
        { method: "get_check_runs", owner: "acme", repo: "web", pullNumber: 7 },
        JSON.stringify({
          total_count: 3,
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "completed", conclusion: "timed_out" },
            { status: "queued", conclusion: null },
          ],
        }),
      ),
      facts: { checks: { passed: 1, failed: 1, pending: 1 } },
    },
    {
      name: "pull_request_read get_status: combined status contexts",
      tool: result(
        "mcp__github__pull_request_read",
        { method: "get_status", owner: "acme", repo: "web", pullNumber: 7 },
        JSON.stringify({
          state: "failure",
          statuses: [{ state: "success" }, { state: "failure" }],
        }),
      ),
      facts: { checks: { passed: 1, failed: 1, pending: 0 } },
    },
    {
      name: "merge_pull_request: merged",
      tool: result(
        "mcp__github__merge_pull_request",
        { owner: "acme", repo: "web", pullNumber: 7 },
        '{"merged":true,"sha":"x","message":"Pull Request successfully merged"}',
      ),
      facts: { state: "merged" },
    },
  ])("$name", async ({ tool, facts, title }) => {
    const [observation] = await run(tool);
    expect(observation).toEqual({
      ref: { host: "github.com", owner: "acme", repo: "web", number: 7 },
      url: "https://github.com/acme/web/pull/7",
      origin: "referenced",
      ...(title ? { title } : {}),
      facts,
    });
  });

  it("does not read a plain `number` as a PR on a non-PR GitHub tool", async () => {
    const tool = result("mcp__github__issue_read", { owner: "acme", repo: "api", number: 5 }, "{}");
    expect(await run(tool)).toEqual([]);
  });
});

describe("observe: other tools", () => {
  it("records a PR URL the model passed to any tool", async () => {
    const tool = result("WebFetch", { url: "https://github.com/acme/api/pull/9/files" }, "<html>");
    expect(await run(tool)).toEqual([
      {
        ref: { ...ORIGIN, number: 9 },
        url: "https://github.com/acme/api/pull/9",
        origin: "referenced",
      },
    ]);
  });

  it("records the PR a job_watch polls through a GitHub tool", async () => {
    const tool = result(
      "job_watch",
      {
        toolCheck: {
          tool: "mcp__github__pull_request_read",
          args: { method: "get_check_runs", owner: "acme", repo: "api", pullNumber: 12 },
        },
      },
      "Watching job 3",
    );
    expect(await run(tool)).toEqual([
      {
        ref: { ...ORIGIN, number: 12 },
        url: "https://github.com/acme/api/pull/12",
        origin: "referenced",
      },
    ]);
  });
});

describe("parsing helpers", () => {
  it("finds each PR URL once, ignoring /pull/new links", () => {
    expect(
      parsePrUrls(
        "https://github.com/a/b/pull/1 https://github.com/a/b/pull/1 https://github.com/a/b/pull/new/x",
      ),
    ).toEqual([
      {
        ref: { host: "github.com", owner: "a", repo: "b", number: 1 },
        url: "https://github.com/a/b/pull/1",
      },
    ]);
  });

  it.each([
    ["https://github.com/acme/api.git", ORIGIN],
    ["git@github.com:acme/api.git", ORIGIN],
    [
      "ssh://git@github.example.com:2222/acme/api",
      { host: "github.example.com", owner: "acme", repo: "api" },
    ],
    ["/srv/git/api.git", undefined],
  ])("parses the remote %s", (url, expected) => {
    expect(parseRemote(url)).toEqual(expected);
  });
});
