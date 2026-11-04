/**
 * pi-git — git worktrees an orchestrator creates in any repository and hands to
 * subagents, and the pull requests the session touches, recorded in the
 * session ledger.
 *
 * Worktrees outlive the subagents that use them: pi-git creates them on named
 * branches under a configured root, records each in the session (`git:ledger`
 * entries, folded across every branch of the session), notes which subagents
 * ran in them, and removes them only when asked.
 *
 * Pull requests are recorded from the session's own tool calls (`gh` in bash,
 * GitHub MCP tools, PR URLs passed to any tool), with the status their output
 * showed. Records a subagent makes are handed up to its parent's ledger. State
 * is published as `git:snapshot`, and a context-only card restores it for the
 * model after a compaction, reload, resume or `/tree`.
 */

import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { Type } from "typebox";
import { showExplorer, sanitizeText } from "../../../packages/pi-ui/src/index.ts";
import {
  call,
  node,
  parentOf,
  provide,
  trackChildren,
} from "../../../packages/pi-session-tree/src/index.ts";
import { CARD_TYPE, contextCard } from "./card.ts";
import { loadGitConfig, type GitConfig } from "./config.ts";
import { GIT_SNAPSHOT_EVENT, snapshotEvent, type GitSnapshotEvent } from "./events.ts";
import { foldLedger } from "./fold.ts";
import { git, realPath, resolveCommit, type BaseRef, type WorktreeStatus } from "./git.ts";
import { isWorktreeRecord, LEDGER_TYPE, type WorktreeRecord } from "./ledger.ts";
import {
  observe,
  outputText,
  parseRemote,
  type Observation,
  type RepoResolver,
  type ToolResultLike,
} from "./observe.ts";
import {
  checksSettled,
  isPrRecord,
  mergeCalls,
  mergePr,
  mergeStatus,
  observedStatus,
  prKey,
  prLabel,
  prUrl,
  sameFacts,
  type PrCall,
  type PrFacts,
  type PrRecord,
  type PrRef,
} from "./prs.ts";
import type { RetryOptions } from "./retry.ts";
import {
  fetchWithGh,
  fetchWithMcp,
  findPullRequestReader,
  GhUnavailable,
  parsePrTarget,
  type Fetched,
  type GhRunner,
  type ToolRunner,
} from "./status.ts";
import {
  explorerView,
  listText,
  prExplorerView,
  prListText,
  prStatusText,
  statusText,
} from "./view.ts";
import {
  atRisk,
  createWorktree,
  findWorktrees,
  inspect,
  isLive,
  removeWorktree,
  within,
  type FoundWorktree,
} from "./worktrees.ts";

/** Session-tree service name: a child hands its records to its parent through it. */
export const SERVICE_NAME = "pi-git";
/** pi-subagent's child lifecycle event; carries the child's agent id and cwd. */
const CHILD_SESSION_CREATED = "subagent:session:created";

export interface GitTreeService {
  version: 1;
  /** Take a descendant's record; persist=false suppresses unchanged polling entries only. */
  adopt(record: unknown, persist?: boolean): boolean;
}

export interface GitExtensionDependencies {
  loadConfig?: (cwd: string) => GitConfig;
  now?: () => number;
  /** Runs `gh`; defaults to the real binary. */
  runGh?: GhRunner;
  /** Retry options for GitHub reads; tests replace the backoff sleep. */
  retry?: RetryOptions;
}

/** At most this many pull requests are read in one git_pr_status or /git:refresh. */
const MAX_STATUS_READS = 20;

const StatusEntry = Type.Object({
  key: Type.String(),
  label: Type.String({ description: "owner/repo#number" }),
  url: Type.String(),
  title: Type.Optional(Type.String()),
  state: Type.Optional(Type.String({ description: "open, closed or merged" })),
  draft: Type.Optional(Type.Boolean()),
  review: Type.Optional(
    Type.String({ description: "approved, changes_requested, review_required or none" }),
  ),
  checks: Type.Optional(
    Type.Object({ passed: Type.Integer(), failed: Type.Integer(), pending: Type.Integer() }),
  ),
  mergeable: Type.Optional(Type.Boolean({ description: "false when there are merge conflicts" })),
  headSha: Type.Optional(Type.String()),
  headRef: Type.Optional(Type.String()),
  ciDone: Type.Boolean({ description: "Checks were reported and none is still pending." }),
  source: Type.Optional(Type.String({ description: "gh, or the MCP tool that answered" })),
  error: Type.Optional(Type.String({ description: "Why the status could not be read." })),
});
const StatusOutput = Type.Object({ prs: Type.Array(StatusEntry) });
type StatusEntryValue = {
  key: string;
  label: string;
  url: string;
  title?: string;
  state?: string;
  draft?: boolean;
  review?: string;
  checks?: { passed: number; failed: number; pending: number };
  mergeable?: boolean;
  headSha?: string;
  headRef?: string;
  ciDone: boolean;
  source?: string;
  error?: string;
};

type Measured = { status: WorktreeStatus } | { error: string };
/** A worktree to act on, with the base its unsaved work is measured against. */
type Target = { record: WorktreeRecord; base: BaseRef };

export default function piGit(pi: ExtensionAPI, dependencies: GitExtensionDependencies = {}): void {
  // Per-session state lives in this closure, never in module scope: every
  // subagent session runs this factory again, and a same-cwd child may share
  // this module with its parent.
  const now = dependencies.now ?? Date.now;
  let records = new Map<string, WorktreeRecord>();
  let prs = new Map<string, PrRecord>();
  let measured = new Map<string, Measured>();
  let found: FoundWorktree[] = [];
  let config: GitConfig | undefined;
  let cwd = process.cwd();
  let sessionId: string | undefined;
  let withdraw: (() => void) | undefined;
  /** Bumped on every session start and shutdown, so a stale refresh drops its results. */
  let generation = 0;
  /**
   * The model may have lost this state: set by a compaction, reload, resume or
   * /tree when there is something to restore, cleared by a list result it can see.
   */
  let showCard = false;

  trackChildren(pi);

  const getConfig = () => (config ??= (dependencies.loadConfig ?? loadGitConfig)(cwd));
  const snapshot = (): GitSnapshotEvent =>
    snapshotEvent(records.values(), measured, found, prs.values());
  const publish = () => pi.events.emit(GIT_SNAPSHOT_EVENT, snapshot());

  /** Hand a record to `from`'s parent, which adopts it and passes it on up. */
  const passUp = (from: string, record: LedgerRecord, persist = true) => {
    const parent = parentOf(from);
    if (parent)
      call<GitTreeService, boolean>(parent, SERVICE_NAME, (s) => s.adopt(record, persist));
  };

  const append = (record: LedgerRecord) => {
    pi.appendEntry<LedgerRecord>(LEDGER_TYPE, record);
    if (record.kind === "pr") prs.set(record.key, record);
    else records.set(record.path, record);
    publish();
    if (sessionId) passUp(sessionId, record);
  };

  const update = (record: WorktreeRecord, change: Partial<WorktreeRecord>) =>
    append({ ...record, ...change, updatedAt: Math.max(now(), record.updatedAt + 1) });

  const service: GitTreeService = {
    version: 1,
    adopt(candidate, persist = true) {
      if (isPrRecord(candidate)) {
        const existing = prs.get(candidate.key);
        const adopted = existing
          ? mergePr(existing, candidate)
          : { ...candidate, via: "adopt" as const };
        if (existing && sameContent(existing, adopted)) return false;
        if (!persist && existing && samePrFacts(existing, adopted)) {
          prs.set(adopted.key, adopted);
          publish();
          if (sessionId) passUp(sessionId, adopted, false);
          return true;
        }
        append(adopted);
        return true;
      }
      if (!isWorktreeRecord(candidate)) return false;
      const existing = records.get(candidate.path);
      const adopted = existing
        ? mergeWorktree(existing, candidate)
        : { ...candidate, via: "adopt" as const };
      // Nothing new ends the hand-up, which also ends any loop in the chain.
      if (existing && sameContent(existing, adopted)) return false;
      append(adopted);
      return true;
    },
  };

  /**
   * Re-measure every active worktree, mark ones deleted outside Pi as missing,
   * and look for worktrees under the root that the ledger does not name.
   */
  const refresh = async (signal?: AbortSignal) => {
    const started = generation;
    const nextMeasured = new Map<string, Measured>();
    const changes: Array<[WorktreeRecord, Partial<WorktreeRecord>]> = [];
    for (const record of records.values()) {
      if (record.state === "removed") continue;
      const live = await isLive(record.path);
      if (!live) {
        if (record.state !== "missing") changes.push([record, { state: "missing" }]);
        continue;
      }
      if (record.state !== "active") changes.push([record, { state: "active" }]);
      nextMeasured.set(record.path, await inspect(record.path, record.base, { signal }));
    }
    // A removed path is not this session's any more: if a worktree is back
    // there (another session made it again), list it with the others.
    const known = new Set(
      [...records.values()].filter((r) => r.state !== "removed").map((r) => r.path),
    );
    const nextFound = await findWorktrees(getConfig().worktreeRoot, known, { signal });
    if (started !== generation) return;
    measured = nextMeasured;
    found = nextFound;
    for (const [record, change] of changes) {
      // Skip a record that changed while git was answering.
      if (records.get(record.path) === record) update(record, change);
    }
    publish();
  };

  /**
   * Refresh without blocking the event. A failure is reported only while the
   * session that started it is still current: after a shutdown or reload its
   * ctx is stale, and touching it throws, which would escape as an unhandled
   * rejection.
   */
  const backgroundRefresh = (ctx: ExtensionContext) => {
    const started = generation;
    refresh().catch((error: unknown) => {
      if (started !== generation) return;
      try {
        if (ctx.hasUI)
          ctx.ui.notify(
            sanitizeText(`pi-git: could not check worktrees: ${errorText(error)}`),
            "warning",
          );
      } catch {
        // The ctx went stale without a shutdown event reaching this extension.
      }
    });
  };

  /** Rebuild state from the session (start, resume, reload, /tree). */
  const restore = (ctx: ExtensionContext): void => {
    const ledger = foldLedger(ctx.sessionManager.getEntries());
    records = ledger.worktrees;
    prs = ledger.prs;
    measured = new Map();
    showCard = contextCard(ledger) !== undefined;
    publish();
  };

  pi.on("session_start", (_event, ctx) => {
    generation += 1;
    cwd = ctx.cwd;
    config = undefined;
    sessionId = ctx.sessionManager.getSessionId();
    withdraw?.();
    withdraw = provide(sessionId, SERVICE_NAME, service);
    restore(ctx);
    backgroundRefresh(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    restore(ctx);
    backgroundRefresh(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    showCard = contextCard(foldLedger(ctx.sessionManager.getEntries())) !== undefined;
  });
  pi.on("context", (event, ctx) => {
    const messages = event.messages.filter(
      (message) => !(message.role === "custom" && message.customType === CARD_TYPE),
    );
    const card = showCard ? contextCard(foldLedger(ctx.sessionManager.getEntries())) : undefined;
    if (!card) return messages.length === event.messages.length ? undefined : { messages };
    return {
      messages: [
        ...messages,
        {
          role: "custom" as const,
          customType: CARD_TYPE,
          content: card,
          display: false,
          timestamp: now(),
        },
      ],
    };
  });
  pi.on("session_shutdown", () => {
    generation += 1;
    withdraw?.();
    withdraw = undefined;
    showCard = false;
  });

  // Note which subagents run in a worktree: pi-subagent announces each child's
  // cwd on this (the parent's) bus before the child starts.
  pi.events.on(CHILD_SESSION_CREATED, (data) => {
    const raw = (data ?? {}) as Record<string, unknown>;
    if (typeof raw.cwd !== "string" || typeof raw.agentId !== "string") return;
    const agentId = raw.agentId;
    const childCwd = realPath(raw.cwd);
    for (const record of records.values()) {
      if (record.state === "removed" || record.agents.includes(agentId)) continue;
      const inWorktree = within(record.path, childCwd);
      const isWorkspace = record.workspacePath !== undefined && record.workspacePath === childCwd;
      if (inWorktree || isWorkspace) update(record, { agents: [...record.agents, agentId] });
    }
  });

  /** The GitHub repository a directory's `origin` remote names, for `gh pr <number>`. */
  const resolveRepo: RepoResolver = async (dir) => {
    try {
      return parseRemote(await git(dir, ["remote", "get-url", "origin"], { timeoutMs: 5_000 }));
    } catch {
      return undefined;
    }
  };

  /**
   * Record what one tool call showed about one pull request. A call that only
   * confirms what the ledger already holds (a watch polling the same status)
   * refreshes the record in memory without writing another entry.
   */
  const recordPr = (observation: Observation, toolCall: PrCall, source = toolCall.tool) => {
    const key = prKey(observation.ref);
    const existing = prs.get(key);
    if (!existing && observation.origin === "referenced" && !getConfig().trackReferenced) return;
    const at = toolCall.at;
    const facts =
      observation.facts && Object.keys(observation.facts).length ? observation.facts : undefined;
    const seen = facts ? observedStatus(facts, at, source) : undefined;
    const base: PrRecord = existing ?? {
      v: 1,
      kind: "pr",
      key,
      ...observation.ref,
      url: observation.url,
      origin: observation.origin,
      calls: [],
      createdAt: at,
      updatedAt: at,
      ...(toolCall.agentId ? { createdBy: toolCall.agentId } : {}),
    };
    const status = mergeStatus(base.status, seen);
    const next: PrRecord = {
      ...base,
      origin:
        base.origin === "created" || observation.origin === "created" ? "created" : "referenced",
      ...(observation.title ? { title: observation.title } : {}),
      ...(status ? { status } : {}),
      calls: mergeCalls(base.calls, [toolCall]),
      updatedAt: existing ? Math.max(at, existing.updatedAt + 1) : at,
    };
    if (
      existing &&
      (toolCall.tool === "git_pr_status" || toolCall.tool === "/git:refresh") &&
      samePrFacts(existing, next)
    ) {
      prs.set(key, next);
      publish();
      if (sessionId) passUp(sessionId, next, false);
      return next;
    }
    append(next);
    return next;
  };

  /** git_pr_status calls in flight; their nested MCP calls are recorded by the tool itself. */
  const ownCalls = new Set<string>();

  /**
   * Read one PR's status: `gh` first, then the GitHub MCP reader when `gh`
   * cannot answer and the caller can run tools.
   */
  const readStatus = async (
    ref: PrRef,
    options: { signal?: AbortSignal; reader?: string; runTool?: ToolRunner },
  ): Promise<Fetched> => {
    try {
      return await fetchWithGh(ref, {
        signal: options.signal,
        ...(dependencies.runGh ? { run: dependencies.runGh } : {}),
        ...(dependencies.retry ? { retry: dependencies.retry } : {}),
      });
    } catch (error) {
      if (!(error instanceof GhUnavailable)) throw error;
      if (!options.reader || !options.runTool)
        throw new Error(
          `${error.message}, and no GitHub MCP pull_request_read tool is available to read it instead`,
        );
      return fetchWithMcp(ref, options.reader, options.runTool, {
        ...dependencies.retry,
        signal: options.signal,
      });
    }
  };

  /** Read and record each PR; read failures become entries, cancellation/session changes throw. */
  const readAndRecord = async (
    refs: readonly PrRef[],
    toolCall: Omit<PrCall, "at">,
    options: { signal?: AbortSignal; reader?: string; runTool?: ToolRunner },
  ): Promise<StatusEntryValue[]> => {
    const started = generation;
    const ensureCurrent = () => {
      options.signal?.throwIfAborted();
      if (started !== generation) throw new Error("The session changed while reading PR status.");
    };
    const entries: StatusEntryValue[] = [];
    for (const ref of refs) {
      ensureCurrent();
      const key = prKey(ref);
      const existing = prs.get(key);
      const base = { key, label: prLabel(ref), url: existing?.url ?? prUrl(ref) };
      try {
        const fetched = await readStatus(ref, options);
        ensureCurrent();
        const recorded = recordPr(
          {
            ref,
            url: base.url,
            origin: existing?.origin ?? "referenced",
            ...(fetched.title ? { title: fetched.title } : {}),
            facts: fetched.facts,
          },
          { ...toolCall, at: now() },
          fetched.source,
        );
        entries.push({
          ...base,
          ...((recorded?.title ?? fetched.title)
            ? { title: recorded?.title ?? fetched.title }
            : {}),
          ...pickFacts(fetched.facts),
          ciDone: checksSettled(fetched.facts),
          source: fetched.source,
        });
      } catch (error) {
        ensureCurrent();
        entries.push({ ...base, ciDone: false, error: errorText(error) });
      }
    }
    return entries;
  };

  // Every tool call: did it touch a pull request? Parsing only; never changes the result.
  pi.on("tool_result", async (event, ctx) => {
    // The model reads a list result only when it made the call itself and it worked.
    if (
      (event.toolName === "git_pr_list" || event.toolName === "git_worktree_list") &&
      !event.isError &&
      !event.parentToolCallId
    )
      showCard = false;
    // git_pr_status records what it read itself, including through nested MCP calls.
    if (event.toolName === "git_pr_status") return;
    if (event.parentToolCallId && ownCalls.has(event.parentToolCallId)) return;
    try {
      const observations = await observe(event as ToolResultLike, { cwd: ctx.cwd, resolveRepo });
      if (observations.length === 0) return;
      const agentId = sessionId ? node(sessionId)?.agentId : undefined;
      for (const observation of observations)
        recordPr(observation, {
          tool: event.toolName,
          toolCallId: event.toolCallId,
          at: now(),
          ...(agentId ? { agentId } : {}),
        });
    } catch {
      // Recording is best effort; a tool's result must never fail because of it.
    }
  });

  /** Remove the worktree; returns what its kept branch still holds that no remote has. */
  const remove = async ({ record, base }: Target, force: boolean, signal?: AbortSignal) => {
    const status = await removeWorktree(
      {
        path: record.path,
        repo: record.repo,
        base,
        root: getConfig().worktreeRoot,
        force,
      },
      { signal },
    );
    measured.delete(record.path);
    // The ledger's newest version of this record (agents may have been added
    // meanwhile), unless the ledger only holds an older, removed one.
    const latest = records.get(record.path);
    update(latest && latest.state !== "removed" ? latest : record, { state: "removed" });
    return status && status.unpushed > 0
      ? ` It holds ${status.unpushed} commit${status.unpushed === 1 ? "" : "s"} that no remote has.`
      : "";
  };

  /**
   * A ledger record for `path`, or a stand-in for a worktree found under the
   * root. A found worktree's base is unknown, so every commit no remote has
   * counts as at risk.
   */
  const target = async (path: string): Promise<Target | undefined> => {
    const resolved = realPath(path);
    const record = records.get(resolved);
    if (record && record.state !== "removed") return { record, base: record.base };
    const root = realPath(getConfig().worktreeRoot);
    if (!within(root, resolved)) return undefined;
    const hit = (await findWorktrees(root, new Set())).find((entry) => entry.path === resolved);
    if (!hit) return undefined;
    const created = now();
    const head = (await resolveCommit(hit.path, "HEAD")) ?? "unknown";
    return {
      record: {
        v: 1,
        kind: "worktree",
        path: hit.path,
        repo: hit.repo,
        branch: hit.branch ?? "(detached)",
        base: { sha: head },
        agents: [],
        state: "active",
        createdAt: created,
        updatedAt: created,
      },
      base: {},
    };
  };

  pi.registerTool(
    defineTool({
      name: "git_worktree_create",
      label: "Git Worktree Create",
      description:
        "Create a git worktree on a named branch, in any repository, for a subagent to work in. " +
        "It is kept until git_worktree_remove: finishing or releasing a subagent never removes it. " +
        "An existing branch is checked out as it is; a new one starts from base (default: the repository's HEAD). " +
        "With workspace, worktrees of several repositories share one directory, one subdirectory per repository. " +
        "Returns the path to pass as cwd to subagent_start.",
      promptSnippet: "Create a git worktree for a subagent to work in; pass its path as cwd.",
      promptGuidelines: [
        "Use git_worktree_create when a subagent should change a repository without touching your checkout, or when parallel subagents would otherwise edit the same files. Then start the subagent with subagent_start and cwd set to the returned path.",
        "For a task that spans repositories, call git_worktree_create once per repository with the same workspace and the same branch, then give the subagent the workspace directory as cwd.",
        "A later subagent can continue in the same worktree: pass the same cwd. Remove it with git_worktree_remove once its branch is merged or pushed.",
      ],
      parameters: Type.Object({
        branch: Type.String({
          description:
            "Branch to work on, e.g. feat/login. Checked out if it exists locally or on exactly one remote; created otherwise.",
        }),
        repo: Type.Optional(
          Type.String({
            description:
              "Path to the repository, absolute or relative to your working directory. Default: the repository you are in.",
          }),
        ),
        base: Type.Optional(
          Type.String({
            description:
              "Commit, tag or branch the new branch starts from. Only for a branch that does not exist yet. Default: the repository's HEAD.",
          }),
        ),
        workspace: Type.Optional(
          Type.String({
            description:
              "Group this worktree with others (from other repositories) under one directory named this. The worktree is created at <workspace>/<repository name>.",
          }),
        ),
      }),
      async execute(_id, params, signal, _update, ctx) {
        try {
          const record = await createWorktree(
            {
              cwd: ctx.cwd,
              root: getConfig().worktreeRoot,
              repo: params.repo,
              branch: params.branch,
              base: params.base,
              workspace: params.workspace,
              now: now(),
              createdBy: sessionId ? node(sessionId)?.agentId : undefined,
            },
            { signal },
          );
          append(record);
          const agentCwd = record.workspacePath ?? record.path;
          const from = record.base.ref
            ? `${record.base.ref} at ${record.base.sha.slice(0, 12)}`
            : record.base.sha.slice(0, 12);
          return {
            content: [
              {
                type: "text",
                text:
                  `Created worktree ${record.path} on branch ${record.branch} (from ${from}) in ${record.repo}.\n` +
                  `Run a subagent there with subagent_start and cwd: "${agentCwd}".`,
              },
            ],
            details: record,
          };
        } catch (error) {
          throw new Error(`git_worktree_create: ${errorText(error)}`);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "git_worktree_list",
      label: "Git Worktree List",
      description:
        "List this session's git worktrees with their repository, branch, workspace, the subagents that ran in them, and their git status: uncommitted changes, commits no remote has, and whether the branch is merged into its base. " +
        "Also lists worktrees under the worktree root that this session did not create.",
      promptSnippet: "List this session's git worktrees and their unsaved work.",
      promptGuidelines: [
        "Use git_worktree_list after a reload, compaction or resume to find the worktrees you handed to subagents before delegating more work.",
      ],
      parameters: Type.Object({
        includeRemoved: Type.Optional(
          Type.Boolean({ description: "Also list worktrees already removed. Default false." }),
        ),
      }),
      annotations: { readOnlyHint: true },
      async execute(_id, params, signal) {
        await refresh(signal);
        const current = snapshot();
        return {
          content: [{ type: "text", text: listText(current, params.includeRemoved === true) }],
          details: current,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "git_worktree_remove",
      label: "Git Worktree Remove",
      description:
        "Remove a git worktree created with git_worktree_create (or found under the worktree root). The branch is always kept. " +
        "Refuses when removal would lose work (uncommitted changes, or commits on a detached HEAD that no branch has), unless force is set. Committed work on the branch is never lost.",
      promptSnippet: "Remove a git worktree; its branch is kept.",
      promptGuidelines: [
        "Use git_worktree_remove once no subagent still needs the worktree, normally after its branch is pushed or merged. Set force only when the user has agreed to discard the uncommitted work it reports.",
      ],
      parameters: Type.Object({
        path: Type.String({
          description: "Worktree path, absolute or relative to your working directory.",
        }),
        force: Type.Optional(
          Type.Boolean({
            description:
              "Remove even when uncommitted changes or commits on a detached HEAD would be lost. Default false.",
          }),
        ),
      }),
      async execute(_id, params, signal, _update, ctx) {
        try {
          const path = realPath(resolvePath(ctx.cwd, params.path));
          const found = await target(path);
          if (!found)
            throw new Error(
              records.get(path)?.state === "removed"
                ? `${path} was already removed`
                : `${path} is not a worktree in this session's ledger or under ${getConfig().worktreeRoot}`,
            );
          const { record } = found;
          const unpushed = await remove(found, params.force === true, signal);
          return {
            content: [
              {
                type: "text",
                text: `Removed worktree ${record.path}; branch ${record.branch} is kept in ${record.repo}.${unpushed}`,
              },
            ],
            details: records.get(record.path),
          };
        } catch (error) {
          throw new Error(`git_worktree_remove: ${errorText(error)}`);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "git_pr_list",
      label: "Git PR List",
      description:
        "List the pull requests this session (and its subagents) opened or looked at, with the last status a tool showed for each: state, review, checks, conflicts, and when and how it was seen. " +
        "Reads the session ledger only; it does not query GitHub. Use git_pr_status for fresh status.",
      promptSnippet: "List the pull requests this session opened or looked at.",
      promptGuidelines: [
        "Use git_pr_list after a reload, compaction or resume to find the pull requests this session opened before checking or changing them again.",
      ],
      parameters: Type.Object({
        includeReferenced: Type.Optional(
          Type.Boolean({
            description: "Also list pull requests the session only looked at. Default true.",
          }),
        ),
      }),
      annotations: { readOnlyHint: true },
      async execute(_id, params) {
        const current = snapshot();
        return {
          content: [
            {
              type: "text",
              text: prListText(current.prs, params.includeReferenced !== false, now()),
            },
          ],
          details: current.prs,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "git_pr_status",
      label: "Git PR Status",
      description:
        "Read pull requests' current status from GitHub (state, draft, review decision, check counts, conflicts, head commit) and record it in the session ledger. " +
        "Uses gh when it is installed and signed in, otherwise a GitHub MCP pull_request_read tool. Retries transient GitHub failures; never writes to GitHub. " +
        `With pr, reads that PR; without it, every pull request this session opened that is not merged or closed (at most ${MAX_STATUS_READS}). ` +
        "The result's ciDone is true once checks were reported and none is pending.",
      promptSnippet: "Read a pull request's current state, review and checks from GitHub.",
      promptGuidelines: [
        "Use git_pr_status to check a pull request's state, review decision, checks or conflicts, instead of reading them with gh or the GitHub MCP tools.",
        'To wait for CI, start job_watch with toolCheck { tool: "git_pr_status", args: { pr }, match: { path: "prs.0.ciDone", equals: true } } and end your turn; then call git_pr_status again and compare headSha with the commit you pushed.',
      ],
      parameters: Type.Object({
        pr: Type.Optional(
          Type.String({
            description:
              "A pull request URL, owner/repo#number, or a number in the current repository. Omit for every open PR this session opened.",
          }),
        ),
        includeReferenced: Type.Optional(
          Type.Boolean({
            description:
              "Without pr, also read open pull requests the session only looked at. Default false.",
          }),
        ),
      }),
      outputSchema: StatusOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
      async execute(id, params, signal, _update, ctx) {
        let refs: PrRef[];
        if (params.pr !== undefined) {
          const repo = /^#?\d+$/.test(params.pr.trim()) ? await resolveRepo(ctx.cwd) : undefined;
          const ref = parsePrTarget(params.pr, repo);
          if (!ref)
            throw new Error(
              `git_pr_status: "${params.pr}" is not a pull request URL, owner/repo#number, or a number in this repository`,
            );
          refs = [ref];
        } else {
          refs = [...prs.values()]
            .filter(
              (pr) =>
                (params.includeReferenced === true || pr.origin === "created") &&
                pr.status?.state !== "merged" &&
                pr.status?.state !== "closed",
            )
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, MAX_STATUS_READS)
            .map(({ host, owner, repo, number }) => ({ host, owner, repo, number }));
        }
        if (refs.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No open pull requests in this session's ledger. Pass pr to read one.",
              },
            ],
            details: { prs: [] },
            structuredContent: { prs: [] },
          };
        }
        const toolCtx = ctx as Partial<ExtensionToolContext>;
        const canRun = typeof toolCtx.executeTool === "function";
        const reader = canRun
          ? findPullRequestReader((toolCtx.tools ?? []).map((tool) => tool.name))
          : undefined;
        const runTool: ToolRunner | undefined = canRun
          ? async (name, args) => {
              const outcome = await toolCtx.executeTool!(name, args, { signal });
              return { isError: outcome.isError, text: outputText(outcome.result.content) };
            }
          : undefined;
        const agentId = sessionId ? node(sessionId)?.agentId : undefined;
        ownCalls.add(id);
        let entries: StatusEntryValue[];
        try {
          entries = await readAndRecord(
            refs,
            { tool: "git_pr_status", toolCallId: id, ...(agentId ? { agentId } : {}) },
            { signal, ...(reader ? { reader } : {}), ...(runTool ? { runTool } : {}) },
          );
        } finally {
          ownCalls.delete(id);
        }
        // One PR that could not be read is a failed call (a watch counts it inconclusive).
        if (entries.every((entry) => entry.error))
          throw new Error(
            `git_pr_status: ${entries.map((entry) => `${entry.label}: ${entry.error}`).join("; ")}`,
          );
        return {
          content: [{ type: "text", text: prStatusText(entries) }],
          details: { prs: entries },
          structuredContent: { prs: entries },
        };
      },
    }),
  );

  pi.registerCommand("git:refresh", {
    description:
      "Re-read every open pull request in this session's ledger from GitHub (through gh) and re-check every worktree",
    handler: async (_args, ctx) => {
      const open = [...prs.values()]
        .filter((pr) => pr.status?.state !== "merged" && pr.status?.state !== "closed")
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_STATUS_READS)
        .map(({ host, owner, repo, number }) => ({ host, owner, repo, number }));
      let worktrees = "worktrees checked";
      try {
        await refresh();
      } catch (error) {
        worktrees = `worktrees not checked: ${errorText(error)}`;
      }
      // A command cannot run tools, so this reads through gh only.
      const entries = await readAndRecord(
        open,
        { tool: "/git:refresh", toolCallId: `refresh-${now()}` },
        {},
      );
      const failed = entries.filter((entry) => entry.error);
      const lines = [
        `Refreshed ${entries.length - failed.length} of ${entries.length} open pull request${entries.length === 1 ? "" : "s"}; ${worktrees}.`,
        ...failed.map((entry) => `${entry.label}: ${entry.error}`),
        ...(failed.some((entry) => /no GitHub MCP/.test(entry.error ?? ""))
          ? [
              "Without gh, ask the agent to run git_pr_status, which can read through the GitHub MCP tools.",
            ]
          : []),
      ];
      ctx.ui.notify(sanitizeText(lines.join("\n")), failed.length ? "warning" : "info");
    },
  });

  pi.registerCommand("git:prs", {
    description:
      "Browse the pull requests this session opened or looked at, with the last status its tools showed",
    handler: async (_args, ctx) => {
      const current = snapshot();
      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify(sanitizeText(prListText(current.prs, true, now())), "info");
        return;
      }
      await showExplorer(ctx, prExplorerView(current.prs, now()), {
        unavailableMessage: "/git:prs requires interactive terminal mode.",
      });
    },
  });

  pi.registerCommand("git:worktrees", {
    description:
      "Browse this session's git worktrees; `/git:worktrees remove` picks one to remove (its branch is kept)",
    handler: async (args, ctx) => {
      try {
        await refresh();
      } catch (error) {
        ctx.ui.notify(sanitizeText(`Could not check worktrees: ${errorText(error)}`), "warning");
      }
      if (args.trim() === "remove") {
        await removeInteractively(ctx);
        return;
      }
      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify(sanitizeText(listText(snapshot(), false)), "info");
        return;
      }
      await showExplorer(ctx, explorerView(snapshot()), {
        unavailableMessage: "/git:worktrees requires interactive terminal mode.",
      });
    },
  });

  const removeInteractively = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const current = snapshot();
    const candidates = [
      ...current.worktrees
        .filter((worktree) => worktree.state !== "removed")
        .map((worktree) => ({
          path: worktree.path,
          label: `${worktree.path} — ${worktree.branch} — ${statusText(worktree)}`,
        })),
      ...current.found.map((entry) => ({
        path: entry.path,
        label: `${entry.path} — ${entry.branch ?? "(detached)"} — not in this session`,
      })),
    ];
    if (candidates.length === 0) {
      ctx.ui.notify("No worktrees to remove.", "info");
      return;
    }
    const choice = await ctx.ui.select(
      "Remove which worktree? Its branch is kept.",
      candidates.map((candidate) => sanitizeText(candidate.label)),
    );
    const picked = candidates.find((candidate) => sanitizeText(candidate.label) === choice);
    if (!picked) return;
    const found = await target(picked.path);
    if (!found) {
      ctx.ui.notify(sanitizeText(`${picked.path} is no longer a worktree.`), "warning");
      return;
    }
    const { record } = found;
    const inspection = (await isLive(record.path))
      ? await inspect(record.path, found.base)
      : undefined;
    const risk = inspection
      ? "error" in inspection
        ? `its state could not be checked (${inspection.error})`
        : atRisk(inspection.status)
      : undefined;
    const confirmed = await ctx.ui.confirm(
      "Remove worktree?",
      sanitizeText(
        risk
          ? `${record.path} has ${risk}. Removing it discards that work; branch ${record.branch} is kept.`
          : `Remove ${record.path}? Branch ${record.branch} is kept.`,
      ),
    );
    if (!confirmed) return;
    try {
      // The user saw the risk and confirmed, so a risky removal is forced.
      const unpushed = await remove(found, risk !== undefined);
      ctx.ui.notify(
        sanitizeText(`Removed ${record.path}; branch ${record.branch} is kept.${unpushed}`),
        "info",
      );
    } catch (error) {
      ctx.ui.notify(sanitizeText(`Could not remove ${record.path}: ${errorText(error)}`), "error");
    }
  };
}

/**
 * Combine this session's record with a descendant's version of it. Agent ids
 * accumulate from both: each session only sees the subagents it starts, and
 * timestamps from separate sessions cannot order those. Every other field
 * comes from the newer version; an equal time (the same millisecond) favours
 * the descendant's, which made the later change.
 */
export function mergeWorktree(existing: WorktreeRecord, candidate: WorktreeRecord): WorktreeRecord {
  const candidateNewer = candidate.updatedAt >= existing.updatedAt;
  const newer = candidateNewer ? candidate : existing;
  const agents = [
    ...existing.agents,
    ...candidate.agents.filter((id) => !existing.agents.includes(id)),
  ];
  return {
    ...newer,
    agents,
    updatedAt: Math.max(existing.updatedAt, candidate.updatedAt),
    ...(candidateNewer ? { via: "adopt" as const } : {}),
  };
}

type LedgerRecord = WorktreeRecord | PrRecord;

/** Equal apart from when and how the record arrived. */
function sameContent(a: LedgerRecord, b: LedgerRecord): boolean {
  const strip = ({ updatedAt: _at, via: _via, ...rest }: LedgerRecord) => JSON.stringify(rest);
  return strip(a) === strip(b);
}

function samePrFacts(a: PrRecord, b: PrRecord): boolean {
  return (
    a.origin === b.origin && a.title === b.title && a.url === b.url && sameFacts(a.status, b.status)
  );
}

/** The status fields a git_pr_status entry reports. */
function pickFacts(facts: PrFacts): Partial<StatusEntryValue> {
  return {
    ...(facts.state ? { state: facts.state } : {}),
    ...(facts.draft !== undefined ? { draft: facts.draft } : {}),
    ...(facts.review ? { review: facts.review } : {}),
    ...(facts.checks ? { checks: facts.checks } : {}),
    ...(facts.mergeable !== undefined ? { mergeable: facts.mergeable } : {}),
    ...(facts.headSha ? { headSha: facts.headSha } : {}),
    ...(facts.headRef ? { headRef: facts.headRef } : {}),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolvePath(cwd: string, path: string): string {
  return resolve(cwd, path);
}
