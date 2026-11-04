import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTransientError, withRetry } from "../src/retry.ts";
import {
  fetchWithGh,
  fetchWithMcp,
  findPullRequestReader,
  GhUnavailable,
  parsePrTarget,
  runGh,
  type ToolRunner,
} from "../src/status.ts";

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
    { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
  ],
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
});

describe("runGh", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  /** A `gh` on PATH that prints `stdout`, or `stderr` and exits 1. */
  const fakeGh = (script: string) => {
    const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
    dirs.push(dir);
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
    vi.stubEnv("PATH", mkdtempSync(join(tmpdir(), "no-gh-")));
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
    });
    expect(runTool).toHaveBeenCalledWith("mcp__github__pull_request_read", {
      method: "get",
      owner: "acme",
      repo: "api",
      pullNumber: 12,
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
});
