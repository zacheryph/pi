/**
 * status.ts — read a pull request's current status from GitHub.
 *
 * Through `gh pr view <url> --json …`; pi-git needs `gh` installed and signed
 * in. Transient failures are retried (see `retry.ts`); nothing here ever
 * writes to GitHub (`ready.ts` does, for git_pr_ready only).
 */
import { isRecord } from "#foundations/guards";

import { execFile } from "node:child_process";
import { failedCheckNames, graphqlFacts, parsePrUrls } from "#src/observe";
import { prUrl, type PrFacts, type PrRef } from "#src/prs";
import { withRetry, type RetryOptions } from "#src/retry";

/** The fields `gh pr view --json` is asked for. */
export const GH_FIELDS =
  "number,url,title,state,isDraft,reviewDecision,mergeable,headRefName,headRefOid,statusCheckRollup,comments,reviews,autoMergeRequest";

export interface Fetched {
  title?: string;
  facts: PrFacts;
  /** What answered: `gh`. */
  source: string;
  /** Names of the failed checks on the head, when the checks were read completely. */
  failedChecks?: string[];
  /** How many top-level comments the pull request has, when the read showed them. */
  comments?: number;
  /** How many reviews were submitted (a reply in a review thread is one too), when read. */
  reviews?: number;
  /** Whether auto-merge is turned on, when the read showed it. */
  autoMerge?: boolean;
}

/** `gh` cannot answer at all (not installed, not signed in): retrying will not help. */
export class GhUnavailable extends Error {
  override name = "GhUnavailable";
}

/** Runs `gh` with arguments and returns stdout; rejects with stderr as the message. */
export type GhRunner = (args: readonly string[], signal?: AbortSignal) => Promise<string>;

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
  const pr = json as Record<string, unknown>;
  const { title, facts } = graphqlFacts(pr);
  return {
    ...(title ? { title } : {}),
    facts: facts ?? {},
    source: "gh",
    ...(facts?.checks && Array.isArray(pr.statusCheckRollup)
      ? { failedChecks: failedCheckNames(pr.statusCheckRollup) }
      : {}),
    ...(Array.isArray(pr.comments) ? { comments: pr.comments.length } : {}),
    ...(Array.isArray(pr.reviews) ? { reviews: pr.reviews.length } : {}),
    ...("autoMergeRequest" in pr ? { autoMerge: isRecord(pr.autoMergeRequest) } : {}),
  };
}
