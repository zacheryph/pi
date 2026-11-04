/**
 * status.ts — read a pull request's current status from GitHub.
 *
 * `gh pr view <url> --json …` first. When `gh` is missing or not signed in, a
 * GitHub MCP `pull_request_read` tool is used instead (its PR object, check
 * runs and reviews). Transient failures are retried (see `retry.ts`); nothing
 * here ever writes to GitHub.
 */

import { execFile } from "node:child_process";
import { graphqlFacts, parsePrUrls, restFacts } from "./observe.ts";
import { prUrl, type PrFacts, type PrRef } from "./prs.ts";
import { withRetry, type RetryOptions } from "./retry.ts";

/** The fields `gh pr view --json` is asked for. */
export const GH_FIELDS =
  "number,url,title,state,isDraft,reviewDecision,mergeable,headRefName,headRefOid,statusCheckRollup";

export interface Fetched {
  title?: string;
  facts: PrFacts;
  /** `gh`, or the name of the MCP tool used. */
  source: string;
}

/** `gh` cannot answer at all (not installed, not signed in): try another way. */
export class GhUnavailable extends Error {
  override name = "GhUnavailable";
}

/** Runs `gh` with arguments and returns stdout; rejects with stderr as the message. */
export type GhRunner = (args: readonly string[], signal?: AbortSignal) => Promise<string>;

/** Runs another tool (an MCP tool) and returns its text and whether it failed. */
export type ToolRunner = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ isError: boolean; text: string }>;

const AUTH_FAILURE = /gh auth login|not logged in|authentication required|GH_TOKEN/i;

export const runGh: GhRunner = (args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      "gh",
      [...args],
      {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
        ...(signal ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(String(stdout));
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        const message = String(stderr || error.message).trim();
        if (code === "ENOENT") reject(new GhUnavailable("gh is not installed"));
        else if (AUTH_FAILURE.test(message))
          reject(new GhUnavailable(`gh is not signed in: ${message}`));
        else reject(new Error(message || `gh ${args.join(" ")} failed`));
      },
    );
  });

/**
 * Which pull request `text` names: a PR URL, `owner/repo#12`, or `#12` / `12`
 * in `repo` (the session's repository).
 */
export function parsePrTarget(
  text: string,
  repo: Omit<PrRef, "number"> | undefined,
): PrRef | undefined {
  const trimmed = text.trim();
  const url = parsePrUrls(trimmed)[0];
  if (url) return url.ref;
  const named = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(trimmed);
  if (named)
    return { host: "github.com", owner: named[1], repo: named[2], number: Number(named[3]) };
  const bare = /^#?(\d+)$/.exec(trimmed);
  if (bare && repo) return { ...repo, number: Number(bare[1]) };
  return undefined;
}

export async function fetchWithGh(
  ref: PrRef,
  options: { run?: GhRunner; signal?: AbortSignal; retry?: RetryOptions } = {},
): Promise<Fetched> {
  const run = options.run ?? runGh;
  const stdout = await withRetry(
    () => run(["pr", "view", prUrl(ref), "--json", GH_FIELDS], options.signal),
    { ...options.retry, signal: options.signal },
  );
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error(`gh pr view returned no JSON: ${stdout.slice(0, 200)}`);
  }
  if (!json || typeof json !== "object" || Array.isArray(json))
    throw new Error("gh pr view returned no pull request");
  const { title, facts } = graphqlFacts(json as Record<string, unknown>);
  return { ...(title ? { title } : {}), facts: facts ?? {}, source: "gh" };
}

/**
 * Read through a GitHub MCP `pull_request_read` tool: the PR object, then its
 * check runs and reviews. The PR object must come back; the other two add
 * what they can.
 */
export async function fetchWithMcp(
  ref: PrRef,
  tool: string,
  runTool: ToolRunner,
  retry: RetryOptions = {},
): Promise<Fetched> {
  const read = async (method: string) => {
    const outcome = await withRetry(async () => {
      const result = await runTool(tool, {
        method,
        owner: ref.owner,
        repo: ref.repo,
        pullNumber: ref.number,
      });
      if (result.isError) throw new Error(result.text || `${tool} ${method} failed`);
      return result.text;
    }, retry);
    try {
      return JSON.parse(outcome) as unknown;
    } catch {
      return undefined;
    }
  };
  const pr = restFacts(await read("get"), "");
  if (!pr.facts && !pr.title) throw new Error(`${tool} returned no pull request`);
  const facts: PrFacts = { ...pr.facts };
  for (const [method, sub] of [
    ["get_check_runs", ""],
    ["get_reviews", "/reviews"],
  ] as const) {
    try {
      Object.assign(facts, restFacts(await read(method), sub).facts);
    } catch {
      // Partial status beats none; the PR object already came back.
    }
  }
  return { ...(pr.title ? { title: pr.title } : {}), facts, source: tool };
}

/** The GitHub MCP tool that reads pull requests, among the tools a call can reach. */
export function findPullRequestReader(toolNames: readonly string[]): string | undefined {
  return (
    toolNames.find((name) => /^mcp__github__pull_request_read$/.test(name)) ??
    toolNames.find((name) => /github.*pull_request_read$/i.test(name))
  );
}
