/**
 * status.ts — read a pull request's current status from GitHub.
 *
 * `gh pr view <url> --json …` first. When `gh` is missing or not signed in, a
 * GitHub MCP `pull_request_read` tool is used instead (its PR object, check
 * runs and reviews). Transient failures are retried (see `retry.ts`); nothing
 * here ever writes to GitHub.
 */
import { isRecord } from "../../../packages/pi-foundations/src/guards.ts";

import { execFile } from "node:child_process";
import { graphqlFacts, parsePrUrls, restFacts } from "./observe.ts";
import { prKey, prUrl, type PrFacts, type PrRef } from "./prs.ts";
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
 * Read through a GitHub MCP `pull_request_read` tool. Only complete check-run
 * and commit-status reads can establish CI completion. Reviews are paginated
 * before deriving the latest decision per reviewer.
 */
export async function fetchWithMcp(
  ref: PrRef,
  tool: string,
  runTool: ToolRunner,
  retry: RetryOptions = {},
): Promise<Fetched> {
  const read = async (method: string, page?: number) => {
    const outcome = await withRetry(async () => {
      const result = await runTool(tool, {
        method,
        owner: ref.owner,
        repo: ref.repo,
        pullNumber: ref.number,
        ...(page !== undefined ? { page, perPage: 100 } : {}),
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
  const getPr = async () => {
    const json = await read("get");
    const parsed = restFacts(json, "");
    if (!parsed.facts?.state) throw new Error(`${tool} returned no pull request`);
    const url = isRecord(json) && typeof json.html_url === "string" ? json.html_url : "";
    const shown = parsePrUrls(url)[0]?.ref;
    if ((shown && prKey(shown) !== prKey(ref)) || (!shown && ref.host !== "github.com"))
      throw new Error(`${tool} returned a pull request from a different repository or host`);
    return parsed;
  };
  const pr = await getPr();
  const facts: PrFacts = { ...pr.facts };

  // Bound a single status read. Hitting the bound leaves that field unknown,
  // rather than reporting a possibly incomplete CI/review result.
  const pages = async (method: "get_check_runs" | "get_reviews") => {
    const items: unknown[] = [];
    for (let page = 1; page <= 20; page++) {
      const json = await read(method, page);
      const rows = method === "get_reviews" ? json : isRecord(json) ? json.check_runs : undefined;
      if (!Array.isArray(rows)) throw new Error(`${tool} returned no ${method}`);
      items.push(...rows);
      const total =
        isRecord(json) && typeof json.total_count === "number" ? json.total_count : undefined;
      if (total !== undefined ? items.length >= total : rows.length < 100) return items;
      if (rows.length === 0) break;
    }
    throw new Error(`${tool} returned incomplete ${method}`);
  };
  try {
    const runs = await pages("get_check_runs");
    const status = await read("get_status");
    if (!isRecord(status) || !Array.isArray(status.statuses))
      throw new Error(`${tool} returned no commit status`);
    // The MCP server's get_status does not expose pagination. If its combined
    // response is truncated, do not infer completion from the visible checks.
    if (typeof status.total_count === "number" && status.total_count > status.statuses.length)
      throw new Error(`${tool} returned incomplete commit statuses`);
    if (typeof status.sha === "string" && status.sha !== facts.headSha)
      throw new Error(`${tool} returned commit statuses for a different head`);
    facts.checks = restFacts({ check_runs: [...runs, ...status.statuses] }, "").facts?.checks;
  } catch {
    retry.signal?.throwIfAborted();
    // Partial metadata is useful, but partial checks must never wake a CI watch.
  }
  try {
    Object.assign(facts, restFacts(await pages("get_reviews"), "/reviews").facts);
  } catch {
    retry.signal?.throwIfAborted();
  }

  // Each MCP method resolves the PR head independently. Do not attach a newer
  // commit's checks to the original head SHA when a push races these reads.
  const latest = await getPr();
  if (latest.facts?.headSha !== facts.headSha)
    throw new Error(`${tool}: pull request head changed while reading status; read it again`);
  retry.signal?.throwIfAborted();
  return { ...(pr.title ? { title: pr.title } : {}), facts, source: tool };
}

/** The GitHub MCP tool that reads pull requests, among the tools a call can reach. */
export function findPullRequestReader(toolNames: readonly string[]): string | undefined {
  return (
    toolNames.find((name) => /^mcp__github__pull_request_read$/.test(name)) ??
    toolNames.find((name) => /github.*pull_request_read$/i.test(name))
  );
}
