import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { tempDir } from "#test-helpers";
import { isTransientError, withRetry } from "#src/retry";
import { checksSettled } from "#src/prs";
import { fetchWithGh, GhUnavailable, parsePrTarget, runGh } from "#src/status";

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
