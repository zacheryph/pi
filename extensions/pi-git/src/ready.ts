/**
 * ready.ts — the GitHub writes behind git_pr_ready: mark a pull request ready
 * for review, and turn on auto-merge pinned to the head the user reviewed.
 *
 * Writes go through `gh`. This is the only module in pi-git that writes to
 * GitHub.
 */
import { prUrl, type PrRef } from "#src/prs";
import { withRetry, type RetryOptions } from "#src/retry";
import type { GhRunner } from "#src/status";

export type MergeMethod = "merge" | "squash" | "rebase";

export const MERGE_METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase"];

/** What turning on auto-merge did. */
export interface AutoMerged {
  /** `merged`: GitHub could merge it at once, so it was merged instead. */
  outcome: "enabled" | "merged";
  /** The method used, when known. */
  method?: MergeMethod;
}

/** One way of writing to GitHub. */
export interface PrWriter {
  /** What writes: `gh`. */
  source: string;
  ready(ref: PrRef): Promise<void>;
  /** Turn on auto-merge for `head`; `method` undefined means the repository's default. */
  autoMerge(ref: PrRef, head: string, method: MergeMethod | undefined): Promise<AutoMerged>;
  /** Turn auto-merge off again. */
  disableAutoMerge(ref: PrRef): Promise<void>;
}

const toMethod = (value: unknown): MergeMethod | undefined => {
  const lower = typeof value === "string" ? value.toLowerCase() : "";
  return (MERGE_METHODS as readonly string[]).includes(lower) ? (lower as MergeMethod) : undefined;
};

/**
 * Writes through `gh`. The repository's default merge method is GitHub's
 * `viewerDefaultMergeMethod`, the one its merge button offers first; it is
 * read once per repository for the writer's lifetime.
 */
export function ghWriter(
  run: GhRunner,
  options: { signal?: AbortSignal; retry?: RetryOptions } = {},
): PrWriter {
  const gh = (args: string[]) =>
    withRetry(() => run(args, options.signal), {
      ...options.retry,
      signal: options.signal,
    });
  const defaults = new Map<string, Promise<MergeMethod>>();
  const defaultMethod = (ref: PrRef) => {
    const repo = `${ref.host}/${ref.owner}/${ref.repo}`;
    let method = defaults.get(repo);
    if (!method) {
      method = gh(["repo", "view", repo, "--json", "viewerDefaultMergeMethod"]).then((stdout) => {
        let json: unknown;
        try {
          json = JSON.parse(stdout);
        } catch {
          json = undefined;
        }
        const found = toMethod(
          (json as { viewerDefaultMergeMethod?: unknown } | undefined)?.viewerDefaultMergeMethod,
        );
        if (!found) throw new Error(`gh repo view did not say ${repo}'s default merge method`);
        return found;
      });
      defaults.set(repo, method);
      // A failed read is not remembered: the next pull request asks again.
      method.catch(() => defaults.delete(repo));
    }
    return method;
  };
  return {
    source: "gh",
    async ready(ref) {
      await gh(["pr", "ready", prUrl(ref)]);
    },
    async autoMerge(ref, head, requested) {
      const method = requested ?? (await defaultMethod(ref));
      // --match-head-commit: GitHub refuses when the head is no longer the reviewed one.
      // When nothing is left to wait for, gh merges it at once; the read after says so.
      await gh(["pr", "merge", prUrl(ref), "--auto", `--${method}`, "--match-head-commit", head]);
      return { outcome: "enabled", method };
    },
    async disableAutoMerge(ref) {
      await gh(["pr", "merge", prUrl(ref), "--disable-auto"]);
    },
  };
}
