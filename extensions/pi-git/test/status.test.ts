import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { tempDir } from "#test-helpers";
import { isTransientError, withRetry } from "#src/retry";
import { checksSettled } from "#src/prs";
import {
  fetchWithGh,
  fetchWithMcp,
  findPullRequestReader,
  GhUnavailable,
  parsePrTarget,
  runGh,
  type ToolRunner,
} from "#src/status";

const REF = { host: "github.com", owner: "acme", repo: "api", number: 12 };
const noSleep = { sleep: vi.fn(async () => undefined) };

const VIEW = JSON.stringify({
  number: 12,
  url: "https://github.com/acme/api/pull/12",
  title: "Add login",
  state: "OPEN",
  isDraft: false,
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
  headRefName: "feat/login",
  headRefOid: "abc123",
  statusCheckRollup: [
    { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
  ],
  comments: [{ body: "one" }, { body: "two" }],
  reviews: [{ state: "APPROVED" }],
});

describe("parsePrTarget", () => {
  it.each([
    ["https://github.com/acme/api/pull/12", REF],
    ["https://github.example.com/acme/api/pull/12/files", { ...REF, host: "github.example.com" }],
    ["acme/api#12", REF],
    ["#12", REF],
    ["12", REF],
  ])("reads %s", (text, expected) => {
    expect(parsePrTarget(text, { host: "github.com", owner: "acme", repo: "api" })).toEqual(
      expected,
    );
  });

  it("needs a repository for a bare number, and rejects anything else", () => {
    expect(parsePrTarget("12", undefined)).toBeUndefined();
    expect(
      parsePrTarget("feat/login", { host: "github.com", owner: "a", repo: "b" }),
    ).toBeUndefined();
  });
});

describe("fetchWithGh", () => {
  it("asks gh for the PR by URL and maps its fields", async () => {
    const run = vi.fn(async () => VIEW);
    expect(await fetchWithGh(REF, { run })).toEqual({
      title: "Add login",
      source: "gh",
      facts: {
        state: "open",
        draft: false,
        review: "approved",
        mergeable: true,
        headRef: "feat/login",
        headSha: "abc123",
        checks: { passed: 1, failed: 1, pending: 0 },
      },
      failedChecks: ["lint"],
      comments: 2,
      reviews: 1,
    });
    expect(run).toHaveBeenCalledWith(
      [
        "pr",
        "view",
        "https://github.com/acme/api/pull/12",
        "--json",
        expect.stringContaining("statusCheckRollup"),
      ],
      undefined,
    );
  });

  it("retries a transient failure, then succeeds", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("HTTP 502: Bad Gateway"))
      .mockResolvedValueOnce(VIEW);
    expect((await fetchWithGh(REF, { run, retry: noSleep })).facts.state).toBe("open");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx or a missing gh", async () => {
    const notFound = vi.fn(async () => {
      throw new Error("GraphQL: Could not resolve to a PullRequest (HTTP 404)");
    });
    await expect(fetchWithGh(REF, { run: notFound, retry: noSleep })).rejects.toThrow(
      /Could not resolve/,
    );
    expect(notFound).toHaveBeenCalledTimes(1);
    const missing = vi.fn(async () => {
      throw new GhUnavailable("gh is not installed");
    });
    await expect(fetchWithGh(REF, { run: missing })).rejects.toBeInstanceOf(GhUnavailable);
  });

  it("reports zero checks for a newly pushed head with an empty rollup", async () => {
    const run = async () => JSON.stringify({ ...JSON.parse(VIEW), statusCheckRollup: [] });
    const { facts } = await fetchWithGh(REF, { run });
    expect(facts.checks).toEqual({ passed: 0, failed: 0, pending: 0 });
    expect(checksSettled(facts)).toBe(false);
  });
});

describe("runGh", () => {
  afterEach(() => vi.unstubAllEnvs());
  /** A `gh` on PATH that prints `stdout`, or `stderr` and exits 1. */
  const fakeGh = (script: string) => {
    const dir = tempDir(onTestFinished, "fake-gh-");
    const gh = join(dir, "gh");
    writeFileSync(gh, `#!/bin/sh\n${script}\n`);
    chmodSync(gh, 0o755);
    vi.stubEnv("PATH", dir);
    return dir;
  };

  it("returns stdout and passes the arguments through", async () => {
    fakeGh('echo "$@"');
    expect((await runGh(["pr", "view", "x"])).trim()).toBe("pr view x");
  });

  it("reports a missing or signed-out gh as unavailable, and other failures as errors", async () => {
    vi.stubEnv("PATH", tempDir(onTestFinished, "no-gh-"));
    await expect(runGh(["pr", "view"])).rejects.toBeInstanceOf(GhUnavailable);
    fakeGh('echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4');
    await expect(runGh(["pr", "view"])).rejects.toBeInstanceOf(GhUnavailable);
    fakeGh('echo "no pull requests found for branch x" >&2; exit 1');
    const error = await runGh(["pr", "view"]).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(GhUnavailable);
    expect((error as Error).message).toBe("no pull requests found for branch x");
  });
});

describe("fetchWithMcp", () => {
  const replies: Record<string, { isError: boolean; text: string }> = {
    get: {
      isError: false,
      text: JSON.stringify({
        number: 12,
        html_url: "https://github.com/acme/api/pull/12",
        title: "Add login",
        state: "open",
        draft: true,
        mergeable: false,
        head: { ref: "feat/login", sha: "def456" },
      }),
    },
    get_check_runs: {
      isError: false,
      text: JSON.stringify({ check_runs: [{ status: "in_progress", conclusion: null }] }),
    },
    get_reviews: { isError: false, text: "[]" },
    get_status: {
      isError: false,
      text: JSON.stringify({ state: "pending", sha: "def456", total_count: 0, statuses: [] }),
    },
  };

  it("combines the PR object, its check runs and its reviews", async () => {
    const runTool: ToolRunner = vi.fn(async (_name, args) => replies[String(args.method)]);
    expect(await fetchWithMcp(REF, "mcp__github__pull_request_read", runTool)).toEqual({
      title: "Add login",
      source: "mcp__github__pull_request_read",
      facts: {
        state: "open",
        draft: true,
        mergeable: false,
        headRef: "feat/login",
        headSha: "def456",
        checks: { passed: 0, failed: 0, pending: 1 },
        review: "none",
      },
      failedChecks: [],
      reviews: 0,
    });
    expect(runTool).toHaveBeenCalledWith("mcp__github__pull_request_read", {
      method: "get",
      owner: "acme",
      repo: "api",
      pullNumber: 12,
    });
  });

  it("names the failed checks and counts comments and reviews", async () => {
    const answers: typeof replies = {
      ...replies,
      get: {
        isError: false,
        text: JSON.stringify({ ...JSON.parse(replies.get!.text), comments: 3 }),
      },
      get_check_runs: {
        isError: false,
        text: JSON.stringify({
          check_runs: [
            { name: "unit", status: "completed", conclusion: "failure" },
            { name: "build", status: "completed", conclusion: "success" },
          ],
        }),
      },
      get_status: {
        isError: false,
        text: JSON.stringify({
          sha: "def456",
          total_count: 1,
          statuses: [{ context: "deploy/preview", state: "failure" }],
        }),
      },
      get_reviews: {
        isError: false,
        text: JSON.stringify([{ state: "COMMENTED", user: { login: "a" } }]),
      },
    };
    const runTool: ToolRunner = async (_name, args) => answers[String(args.method)]!;
    expect(await fetchWithMcp(REF, "mcp__github__pull_request_read", runTool)).toMatchObject({
      facts: { checks: { passed: 1, failed: 2, pending: 0 } },
      failedChecks: ["unit", "deploy/preview"],
      comments: 3,
      reviews: 1,
    });
  });

  it("fails without the PR object, but keeps it when only checks or reviews fail", async () => {
    const failing: ToolRunner = async () => ({ isError: true, text: "Not Found" });
    await expect(fetchWithMcp(REF, "t", failing, noSleep)).rejects.toThrow("Not Found");
    const partial: ToolRunner = async (_name, args) =>
      args.method === "get" ? replies.get : { isError: true, text: "forbidden" };
    expect((await fetchWithMcp(REF, "t", partial, noSleep)).facts).toEqual({
      state: "open",
      draft: true,
      mergeable: false,
      headRef: "feat/login",
      headSha: "def456",
    });
  });

  it.each(["pending", "failure"])(
    "includes a legacy %s status alongside successful check runs",
    async (state) => {
      const runTool: ToolRunner = async (_name, args) => ({
        isError: false,
        text:
          args.method === "get_check_runs"
            ? JSON.stringify({
                total_count: 1,
                check_runs: [{ status: "completed", conclusion: "success" }],
              })
            : args.method === "get_status"
              ? JSON.stringify({ state, sha: "def456", total_count: 1, statuses: [{ state }] })
              : replies[String(args.method)].text,
      });
      const { facts } = await fetchWithMcp(REF, "t", runTool);
      expect(facts.checks).toEqual({
        passed: 1,
        failed: state === "failure" ? 1 : 0,
        pending: state === "pending" ? 1 : 0,
      });
      expect(checksSettled(facts)).toBe(state === "failure");
    },
  );

  it("supports repositories that use only legacy status checks", async () => {
    const runTool: ToolRunner = async (_name, args) => ({
      isError: false,
      text:
        args.method === "get_check_runs"
          ? JSON.stringify({ total_count: 0, check_runs: [] })
          : args.method === "get_status"
            ? JSON.stringify({
                state: "success",
                sha: "def456",
                total_count: 1,
                statuses: [{ state: "success" }],
              })
            : replies[String(args.method)].text,
    });
    const { facts } = await fetchWithMcp(REF, "t", runTool);
    expect(facts.checks).toEqual({ passed: 1, failed: 0, pending: 0 });
    expect(checksSettled(facts)).toBe(true);
  });

  it("reads all pages before deriving check counts or review decisions", async () => {
    const runTool: ToolRunner = vi.fn(async (_name, args) => {
      if (args.method === "get_check_runs")
        return {
          isError: false,
          text: JSON.stringify({
            total_count: 101,
            check_runs:
              args.page === 1
                ? Array.from({ length: 100 }, () => ({
                    status: "completed",
                    conclusion: "success",
                  }))
                : [{ status: "queued", conclusion: null }],
          }),
        };
      if (args.method === "get_reviews")
        return {
          isError: false,
          text: JSON.stringify(
            args.page === 1
              ? Array.from({ length: 100 }, () => ({ user: { login: "a" }, state: "APPROVED" }))
              : [{ user: { login: "a" }, state: "CHANGES_REQUESTED" }],
          ),
        };
      return replies[String(args.method)];
    });
    const { facts } = await fetchWithMcp(REF, "t", runTool);
    expect(facts.checks).toEqual({ passed: 100, failed: 0, pending: 1 });
    expect(facts.review).toBe("changes_requested");
    expect(checksSettled(facts)).toBe(false);
    expect(runTool).toHaveBeenCalledWith(
      "t",
      expect.objectContaining({ method: "get_check_runs", page: 2, perPage: 100 }),
    );
  });

  it.each(["missing", "truncated"])(
    "leaves checks unknown if legacy statuses are %s",
    async (kind) => {
      const runTool: ToolRunner = async (_name, args) => {
        if (args.method === "get_check_runs")
          return {
            isError: false,
            text: JSON.stringify({ check_runs: [{ status: "completed", conclusion: "success" }] }),
          };
        if (args.method === "get_status")
          return kind === "missing"
            ? { isError: true, text: "forbidden" }
            : {
                isError: false,
                text: JSON.stringify({ total_count: 31, statuses: [{ state: "success" }] }),
              };
        return replies[String(args.method)];
      };
      const { facts } = await fetchWithMcp(REF, "t", runTool);
      expect(facts.state).toBe("open");
      expect(facts.checks).toBeUndefined();
      expect(checksSettled(facts)).toBe(false);
    },
  );

  it("does not publish counts from an incomplete check-run page", async () => {
    const runTool: ToolRunner = async (_name, args) =>
      args.method === "get_check_runs"
        ? args.page === 1
          ? {
              isError: false,
              text: JSON.stringify({
                total_count: 101,
                check_runs: [{ status: "completed", conclusion: "success" }],
              }),
            }
          : { isError: true, text: "forbidden" }
        : replies[String(args.method)];
    const { facts } = await fetchWithMcp(REF, "t", runTool);
    expect(facts.checks).toBeUndefined();
    expect(facts.review).toBe("none");
  });

  it("rejects mixed-head reads if a push happens between MCP requests", async () => {
    let gets = 0;
    const runTool: ToolRunner = async (_name, args) => {
      if (args.method === "get" && ++gets === 2)
        return {
          isError: false,
          text: JSON.stringify({ ...JSON.parse(replies.get.text), head: { sha: "new-head" } }),
        };
      return replies[String(args.method)];
    };
    await expect(fetchWithMcp(REF, "t", runTool)).rejects.toThrow("head changed");
  });

  it("rejects an MCP reader connected to a different GitHub host", async () => {
    const runTool: ToolRunner = async (_name, args) => replies[String(args.method)];
    await expect(
      fetchWithMcp({ ...REF, host: "github.example.com" }, "t", runTool),
    ).rejects.toThrow("different repository or host");
  });

  it("propagates cancellation during an optional MCP read without more requests or backoff", async () => {
    const controller = new AbortController();
    const sleep = vi.fn(async () => undefined);
    const runTool: ToolRunner = vi.fn(async (_name, args) => {
      if (args.method === "get_check_runs") {
        controller.abort(new Error("cancelled"));
        throw new Error("HTTP 502");
      }
      return replies[String(args.method)];
    });
    await expect(
      fetchWithMcp(REF, "t", runTool, { signal: controller.signal, sleep }),
    ).rejects.toThrow("cancelled");
    expect(runTool).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("finds the GitHub MCP reader among the reachable tools", () => {
    expect(findPullRequestReader(["bash", "mcp__github__pull_request_read"])).toBe(
      "mcp__github__pull_request_read",
    );
    expect(findPullRequestReader(["mcp__gh-enterprise__github_pull_request_read"])).toBe(
      "mcp__gh-enterprise__github_pull_request_read",
    );
    expect(findPullRequestReader(["bash", "mcp__github__issue_read"])).toBeUndefined();
  });
});

describe("withRetry (from pi-github-tools)", () => {
  it("classifies 5xx, GraphQL unavailability and transport errors as transient, never 4xx", () => {
    for (const message of [
      "HTTP 503",
      "no server is currently available",
      "read: connection reset by peer",
      "unexpected EOF",
      "dial tcp: lookup api.github.com",
    ])
      expect(isTransientError(new Error(message)), message).toBe(true);
    for (const message of ["HTTP 404", "HTTP 403: rate limit exceeded", "HTTP 422"])
      expect(isTransientError(new Error(message)), message).toBe(false);
  });

  it("gives up after three retries with the last error", async () => {
    const fn = vi.fn(async () => {
      throw new Error("HTTP 500");
    });
    await expect(withRetry(fn, noSleep)).rejects.toThrow("HTTP 500");
    expect(fn).toHaveBeenCalledTimes(4);
    expect(noSleep.sleep).toHaveBeenCalledWith(9000, undefined);
  });

  it("does not start a request with an already cancelled signal", async () => {
    const fn = vi.fn(async () => "ok");
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(withRetry(fn, { signal })).rejects.toThrow("cancelled");
    expect(fn).not.toHaveBeenCalled();
  });
});
