/**
 * ready.ts — the GitHub writes behind git_pr_ready: mark a pull request ready
 * for review, and turn on auto-merge pinned to the head the user reviewed.
 *
 * Writes go the same way the read before them went: through `gh` when it
 * answered, otherwise through the GitHub MCP tools (`update_pull_request`,
 * `enable_pr_auto_merge`, `merge_pull_request`, `disable_pr_auto_merge`).
 * This is the only module in pi-git that writes to GitHub.
 */
import { prUrl, type PrRef } from "#src/prs";
import { withRetry, type RetryOptions } from "#src/retry";
import type { GhRunner, ToolRunner } from "#src/status";

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
  /** `gh`, or the MCP tool family used. */
  source: string;
  ready(ref: PrRef): Promise<void>;
  /** Turn on auto-merge for `head`; `method` undefined means the repository's default. */
  autoMerge(ref: PrRef, head: string, method: MergeMethod | undefined): Promise<AutoMerged>;
  /** Turn auto-merge off again, when this writer can. */
  disableAutoMerge?(ref: PrRef): Promise<void>;
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

/** The GitHub MCP tools that write pull requests, among the tools a call can reach. */
export interface McpWriteTools {
  update?: string;
  enableAutoMerge?: string;
  disableAutoMerge?: string;
  merge?: string;
}

export function findPullRequestWriters(toolNames: readonly string[]): McpWriteTools {
  const find = (method: string) =>
    toolNames.find((name) => name === `mcp__github__${method}`) ??
    toolNames.find((name) => new RegExp(`github.*${method}$`, "i").test(name));
  const tools: McpWriteTools = {};
  const update = find("update_pull_request");
  const enable = find("enable_pr_auto_merge");
  const disable = find("disable_pr_auto_merge");
  const merge = find("merge_pull_request");
  if (update) tools.update = update;
  if (enable) tools.enableAutoMerge = enable;
  if (disable) tools.disableAutoMerge = disable;
  if (merge) tools.merge = merge;
  return tools;
}

/** GitHub's answer when every requirement is already met: there is nothing to wait for. */
const CLEAN_STATUS = /clean status|already (?:be )?mergeable|is in clean/i;

/**
 * Writes through the GitHub MCP tools. `enable_pr_auto_merge` takes no
 * expected head, so the caller reads the PR again afterwards and turns
 * auto-merge off when the head moved.
 */
export function mcpWriter(
  tools: McpWriteTools,
  runTool: ToolRunner,
  retry: RetryOptions = {},
): PrWriter {
  const call = (name: string | undefined, method: string, args: Record<string, unknown>) => {
    if (!name) throw new Error(`no GitHub MCP ${method} tool is available`);
    return withRetry(async () => {
      const result = await runTool(name, args);
      if (result.isError) throw new Error(result.text || `${name} failed`);
      return result.text;
    }, retry);
  };
  const target = (ref: PrRef) => ({
    owner: ref.owner,
    repo: ref.repo,
    pullNumber: ref.number,
  });
  return {
    source: tools.update ?? tools.enableAutoMerge ?? "GitHub MCP",
    async ready(ref) {
      await call(tools.update, "update_pull_request", {
        ...target(ref),
        draft: false,
      });
    },
    async autoMerge(ref, head, method) {
      try {
        await call(tools.enableAutoMerge, "enable_pr_auto_merge", {
          ...target(ref),
          ...(method ? { mergeMethod: method.toUpperCase() } : {}),
        });
        return { outcome: "enabled", ...(method ? { method } : {}) };
      } catch (error) {
        if (!(error instanceof Error) || !CLEAN_STATUS.test(error.message)) throw error;
        // Nothing left to wait for: merge it now, as gh does, pinned to the reviewed head.
        if (!method)
          throw new Error(
            'it can be merged now, so GitHub will not turn on auto-merge for it, and the GitHub MCP tools do not say the repository\'s default merge method: pass autoMerge "squash", "merge" or "rebase" to merge it',
            { cause: error },
          );
        await call(tools.merge, "merge_pull_request", {
          ...target(ref),
          merge_method: method,
          expectedHeadSha: head,
        });
        return { outcome: "merged", method };
      }
    },
    ...(tools.disableAutoMerge
      ? {
          async disableAutoMerge(ref: PrRef) {
            await call(tools.disableAutoMerge, "disable_pr_auto_merge", target(ref));
          },
        }
      : {}),
  };
}
