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
 * is published as pi-surface views, and a context-only card restores it for the
 * model after a compaction, reload, resume or `/tree`.
 *
 * `git_pr_watch` waits on a pull request: a work item (packages/pi-work) that
 * reads it on a timer and wakes the session when it changes (see watch.ts).
 */
import { errorText } from "#foundations/errors";
import { userOutput } from "#foundations/user-output";

import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { Type } from "typebox";
import { actionRegistry, viewRegistry } from "#surface";
import { showExplorer, sanitizeLine, sanitizeText } from "#ui";
import { readEntries, restoreCard, treeService, type EntriesSource } from "#session-state";
import { ensureWorkHost } from "#work";
import {
  ATTENTION_TYPE,
  ATTENTION_VERSION,
  attentionModel,
  GIT_ATTENTION_DISMISS,
  GIT_ATTENTION_VIEW,
  FULL_SHA,
  isAttentionEntry,
  isPrIdentity,
  MAX_REQUEST_REASON,
  readReviews,
  reduceReviews,
  rowForItem,
  type AttentionEntry,
  type ReviewRequest,
  type ReviewRow,
  type ReviewRows,
} from "#src/attention";
import { CARD_TYPE, ledgerCard } from "#src/card";
import { gitSettings, type GitConfig } from "#src/config";
import { GIT_PRS_VIEW, GIT_SUMMARY_VIEW, GIT_WORKTREES_VIEW } from "#src/events";
import { gitSnapshot, type GitSnapshot } from "#src/snapshot";
import { readLedger, type Ledger } from "#src/fold";
import { gitSummaryModel } from "#src/summary";
import { git, realPath, resolveCommit, type BaseRef, type WorktreeStatus } from "#src/git";
import { isWorktreeRecord, LEDGER_TYPE, type WorktreeRecord } from "#src/ledger";
import {
  observe,
  outputText,
  parseRemote,
  type Observation,
  type RepoResolver,
  type ToolResultLike,
} from "#src/observe";
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
} from "#src/prs";
import {
  findPullRequestWriters,
  ghWriter,
  MERGE_METHODS,
  mcpWriter,
  type MergeMethod,
  type PrWriter,
} from "#src/ready";
import type { RetryOptions } from "#src/retry";
import {
  fetchWithGh,
  fetchWithMcp,
  findPullRequestReader,
  GhUnavailable,
  parsePrTarget,
  runGh as realGh,
  type Fetched,
  type GhRunner,
  type ToolRunner,
} from "#src/status";
import {
  DEFAULT_TIMEOUT_SECONDS,
  describeWatch,
  FinalReadError,
  isSavedBaseline,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  PrWatches,
  WATCH_ENTRY,
  WATCH_OWNER,
  type Baseline,
  type Reading,
  type SavedBaseline,
  type WatchUntil,
} from "#src/watch";
import {
  explorerView,
  listText,
  prExplorerView,
  prListText,
  prReadyText,
  prStatusText,
  statusText,
} from "#src/view";
import {
  atRisk,
  createWorktree,
  findWorktrees,
  inspect,
  isLive,
  removeWorktree,
  within,
  type FoundWorktree,
} from "#src/worktrees";

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
  /** Milliseconds between a watch's reads; default: the `watchIntervalSeconds` setting. */
  watchIntervalMs?: number;
  /** Sees the session's state each time its views announce a change; tests observe through it. */
  onPublish?: (snapshot: GitSnapshot) => void;
}

/** What a watch needs to read through the GitHub MCP tools: the context of the call that started it. */
interface McpAccess {
  reader: string;
  runTool: ToolRunner;
}

/** The session's tools as a `ToolRunner`, when the tool context can run them. */
function mcpAccess(ctx: unknown, signal?: AbortSignal): McpAccess | undefined {
  const toolCtx = ctx as Partial<ExtensionToolContext>;
  if (typeof toolCtx.executeTool !== "function") return undefined;
  const reader = findPullRequestReader((toolCtx.tools ?? []).map((tool) => tool.name));
  if (!reader) return undefined;
  return {
    reader,
    runTool: async (name, args) => {
      const outcome = await toolCtx.executeTool!(name, args, signal ? { signal } : {});
      return { isError: outcome.isError, text: outputText(outcome.result.content) };
    },
  };
}

/** The session's tool names and a `ToolRunner` over them, when the tool context can run them. */
function toolAccess(
  ctx: unknown,
  signal?: AbortSignal,
): { names: string[]; runTool: ToolRunner } | undefined {
  const toolCtx = ctx as Partial<ExtensionToolContext>;
  if (typeof toolCtx.executeTool !== "function") return undefined;
  return {
    names: (toolCtx.tools ?? []).map((tool) => tool.name),
    runTool: async (name, args) => {
      const outcome = await toolCtx.executeTool!(name, args, signal ? { signal } : {});
      return {
        isError: outcome.isError,
        text: outputText(outcome.result.content),
      };
    },
  };
}

/** pi-git's tools that read GitHub and record what they read themselves; the observer skips them. */
const OWN_READS: ReadonlySet<string> = new Set([
  "git_pr_status",
  "git_pr_watch",
  "git_pr_request_review",
  "git_pr_ready",
]);

/** Calls that read the same status again and again: an unchanged read writes no ledger entry. */
const POLLING_TOOLS: ReadonlySet<string> = new Set([
  "git_pr_status",
  "git_pr_watch",
  "/git:refresh",
]);

/** At most this many pull requests are read in one git_pr_status or /git:refresh. */
const MAX_STATUS_READS = 20;
/** At most this many pull requests are marked in one git_pr_ready. */
const MAX_READY = 20;

const ReadyEntry = Type.Object({
  key: Type.String(),
  label: Type.String({ description: "owner/repo#number" }),
  url: Type.String(),
  head: Type.Optional(Type.String({ description: "The head commit it was marked at." })),
  ready: Type.Optional(
    Type.String({
      description: "marked, or already when it was ready for review before",
    }),
  ),
  autoMerge: Type.Optional(
    Type.String({
      description:
        "enabled, already (it was on before), or merged (nothing was left to wait for, so it was merged)",
    }),
  ),
  method: Type.Optional(
    Type.String({
      description: "The merge method used: merge, squash or rebase.",
    }),
  ),
  state: Type.Optional(Type.String({ description: "open, closed or merged, as read afterwards" })),
  dismissed: Type.Optional(
    Type.Boolean({
      description: "The review request waiting on the user for it was resolved.",
    }),
  ),
  note: Type.Optional(
    Type.String({
      description: "Something to know about a PR that was marked.",
    }),
  ),
  error: Type.Optional(Type.String({ description: "Why it was not marked, or not completely." })),
});
const ReadyOutput = Type.Object({ prs: Type.Array(ReadyEntry) });
type ReadyEntryValue = {
  key: string;
  label: string;
  url: string;
  head?: string;
  ready?: "marked" | "already";
  autoMerge?: "enabled" | "already" | "merged";
  method?: MergeMethod;
  state?: string;
  dismissed?: boolean;
  note?: string;
  error?: string;
};

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
  // First, so the session's work host is provided before this extension's session_start runs.
  const work = ensureWorkHost(pi);
  const output = userOutput(pi, "git:output");
  // Per-session state lives in this closure, never in module scope: every
  // subagent session runs this factory again, and a same-cwd child may share
  // this module with its parent.
  const now = dependencies.now ?? Date.now;
  let records = new Map<string, WorktreeRecord>();
  let prs = new Map<string, PrRecord>();
  /** PRs handed to the user for review (attention.ts), folded with the ledger's PR facts. */
  let reviews: ReviewRows = new Map();
  let measured = new Map<string, Measured>();
  let found: FoundWorktree[] = [];
  let config: GitConfig | undefined;
  let cwd = process.cwd();
  /** Bumped on every session start and shutdown, so a stale refresh drops its results. */
  let generation = 0;

  const getConfig = () => (config ??= (dependencies.loadConfig ?? gitSettings.load)(cwd));
  const snapshot = (): GitSnapshot =>
    gitSnapshot(records.values(), measured, found, prs.values(), watches.list());
  // The /git:worktrees and /git:prs explorers, as views a remote surface draws.
  // They live from session start to shutdown, so a /reload does not leak them.
  const views = viewRegistry(pi.events);
  const actions = actionRegistry(pi.events);
  const defineViews = () => {
    views.dispose();
    actions.dispose();
    views.define({
      id: GIT_WORKTREES_VIEW,
      kind: "explorer",
      title: "Git worktrees",
      model: () => explorerView(snapshot()),
    });
    views.define({
      id: GIT_PRS_VIEW,
      kind: "explorer",
      title: "Pull requests",
      model: () => prExplorerView(snapshot().prs, now()),
    });
    views.define({
      id: GIT_SUMMARY_VIEW,
      kind: "summary",
      title: "Git",
      model: () => gitSummaryModel(snapshot()),
    });
    views.define({
      id: GIT_ATTENTION_VIEW,
      kind: "attention",
      title: "Git reviews",
      model: () => attentionModel(reviews, prs),
    });
    actions.define<{ id: string; rev: string }>({
      id: GIT_ATTENTION_DISMISS,
      title: "Dismiss a review request",
      parse: (args) => {
        const { id, rev } = (args ?? {}) as Record<string, unknown>;
        if (typeof id !== "string" || typeof rev !== "string")
          throw new Error("expected { id, rev } from the attention item");
        return { id, rev };
      },
      handler: ({ id, rev }) => {
        const row = rowForItem(reviews, id);
        if (!row) throw new Error(`No review request "${id}" is open.`);
        // The user saw another head: what they dismissed is not what is owed now.
        if (row.request.head.toLowerCase() !== rev.toLowerCase())
          throw new Error(`The review request "${id}" changed since it was shown.`);
        recordIntent({
          v: ATTENTION_VERSION,
          kind: "dismissal",
          key: row.request.key,
          head: row.request.head,
          at: now(),
        });
        return { dismissed: true };
      },
    });
  };
  const publish = () => {
    dependencies.onPublish?.(snapshot());
    views.changed(GIT_WORKTREES_VIEW);
    views.changed(GIT_PRS_VIEW);
    views.changed(GIT_SUMMARY_VIEW);
    // Also when only a PR's observation time moved: the items show it.
    views.changed(GIT_ATTENTION_VIEW);
  };

  /**
   * Write a review request or dismissal. These stay in this session: a
   * subagent's ledger records reach its parent, its intent never does.
   */
  const recordIntent = (entry: AttentionEntry) => {
    pi.appendEntry<AttentionEntry>(ATTENTION_TYPE, entry);
    reviews = reduceReviews(reviews, entry);
    publish();
  };

  /** Hand a record to this session's parent, which adopts it and passes it on up. */
  const passUp = (record: LedgerRecord, persist = true) =>
    tree.parent((parent) => parent.adopt(record, persist));

  const append = (record: LedgerRecord) => {
    pi.appendEntry<LedgerRecord>(LEDGER_TYPE, record);
    if (record.kind === "pr") {
      prs.set(record.key, record);
      // Only written records move a review row, so replaying the session reaches the same rows.
      reviews = reduceReviews(reviews, record);
    } else records.set(record.path, record);
    publish();
    passUp(record);
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
          passUp(adopted, false);
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

  /** Resolve identities from local origin remotes; unknown repositories remain unlinked. */
  const cardForLedger = async (ledger: Ledger): Promise<string | undefined> => {
    const repositories = new Map<string, Omit<PrRef, "number">>();
    if (ledger.prs.size) {
      const paths = new Set(
        [...ledger.worktrees.values()].filter((w) => w.state !== "removed").map((w) => w.repo),
      );
      await Promise.all(
        [...paths].map(async (path) => {
          const repository = await resolveRepo(path);
          if (repository) repositories.set(path, repository);
        }),
      );
    }
    return ledgerCard(ledger, repositories);
  };

  /** Rebuild state from the session (start, resume, reload, /tree). */
  const restore = (ctx: ExtensionContext): void => {
    const ledger = readLedger(ctx);
    records = ledger.worktrees;
    prs = ledger.prs;
    reviews = readReviews(ctx);
    measured = new Map();
    publish();
  };

  // Initialize and provide together: a shutdown between separate start handlers
  // must not let the older start provide the service again after it was withdrawn.
  const tree = treeService<GitTreeService>(pi, SERVICE_NAME, service, {
    start: (ctx) => {
      generation += 1;
      cwd = ctx.cwd;
      config = undefined;
      defineViews();
      restore(ctx);
      adoptWatches(ctx);
      backgroundRefresh(ctx);
    },
  });
  pi.on("session_tree", (_event, ctx) => {
    restore(ctx);
    backgroundRefresh(ctx);
  });
  // A compaction summarizes away the tool results that showed this state, so
  // the ledger is written back once after it.
  restoreCard(pi, {
    type: CARD_TYPE,
    build: (ctx, event) => {
      // A start event can reach this later handler after shutdown already ran.
      if (tree.sessionId() === undefined) return undefined;
      // Start/tree already replayed before Pi yielded; their ctx may now be stale.
      const ledger =
        event.type === "session_compact" ? readLedger(ctx) : { worktrees: records, prs };
      return cardForLedger(ledger);
    },
  });
  pi.on("session_shutdown", () => {
    generation += 1;
    views.dispose();
    actions.dispose();
    // The watches' items stay open in the transcript: the next start adopts them.
    watches.shutdown();
    watchAccess.clear();
    ownCalls.clear();
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
  const recordPr = (
    observation: Observation,
    toolCall: PrCall,
    source = toolCall.tool,
    /** Record it even when only looked at and `trackReferenced` is off: the session waits on it. */
    always = false,
  ) => {
    const key = prKey(observation.ref);
    const existing = prs.get(key);
    if (!always && !existing && observation.origin === "referenced" && !getConfig().trackReferenced)
      return;
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
    if (existing && POLLING_TOOLS.has(toolCall.tool) && samePrFacts(existing, next)) {
      prs.set(key, next);
      publish();
      passUp(next, false);
      return next;
    }
    append(next);
    return next;
  };

  /**
   * git_pr_status calls in flight and the calls that started a watch still running; their nested
   * MCP calls are recorded by the tool itself.
   */
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
        throw new FinalReadError(
          `${error.message}, and no GitHub MCP pull_request_read tool is available to read it instead`,
        );
      return fetchWithMcp(ref, options.reader, options.runTool, {
        ...dependencies.retry,
        signal: options.signal,
      });
    }
  };

  /** Record what a fresh read showed about one PR. */
  const recordFetched = (
    ref: PrRef,
    fetched: Fetched,
    toolCall: Omit<PrCall, "at">,
    always = false,
  ) => {
    const existing = prs.get(prKey(ref));
    return recordPr(
      {
        ref,
        url: existing?.url ?? prUrl(ref),
        origin: existing?.origin ?? "referenced",
        ...(fetched.title ? { title: fetched.title } : {}),
        facts: fetched.facts,
      },
      { ...toolCall, at: now() },
      fetched.source,
      always,
    );
  };

  /**
   * How each running watch reaches the GitHub MCP tools, by PR key: the context of the newest
   * git_pr_watch call for it, whose id its nested calls carry. Gone after a reload.
   */
  const watchAccess = new Map<string, McpAccess & { callId: string }>();
  const bindAccess = (key: string, callId: string, access: McpAccess | undefined) => {
    const previous = watchAccess.get(key);
    if (previous && previous.callId !== callId) ownCalls.delete(previous.callId);
    if (access) watchAccess.set(key, { ...access, callId });
    else ownCalls.delete(callId);
  };

  /** Read a watched PR and record it. `gh` first; the MCP tools of the call that started the watch otherwise. */
  const readWatched = async (
    watch: { key: string; ref: PrRef; callId: string },
    signal: AbortSignal,
  ): Promise<Reading> => {
    const started = generation;
    const fetched = await readStatus(watch.ref, { signal, ...watchAccess.get(watch.key) });
    signal.throwIfAborted();
    if (started !== generation) throw new Error("The session changed while reading PR status.");
    const agentId = tree.node()?.agentId;
    recordFetched(
      watch.ref,
      fetched,
      { tool: "git_pr_watch", toolCallId: watch.callId, ...(agentId ? { agentId } : {}) },
      true,
    );
    return fetched;
  };

  const watches = new PrWatches({
    host: () => work.host(),
    read: readWatched,
    saveBaseline: (saved) => pi.appendEntry<SavedBaseline>(WATCH_ENTRY, saved),
    onChange: () => publish(),
    onEnd: (watch) => {
      const access = watchAccess.get(watch.key);
      watchAccess.delete(watch.key);
      if (access) ownCalls.delete(access.callId);
    },
    now,
    intervalMs: () => dependencies.watchIntervalMs ?? getConfig().watchIntervalSeconds * 1000,
  });

  /**
   * Take back the watches an earlier instance of this session left open, each from the newest
   * baseline it saved. What is not adopted (a fork's inherited items) the host closes as lost.
   */
  const adoptWatches = (ctx: ExtensionContext & EntriesSource) => {
    const host = work.host();
    if (!host) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const saved = new Map<string, Baseline>();
    for (const entry of readEntries(ctx, {
      type: WATCH_ENTRY,
      scope: "all",
      guard: isSavedBaseline,
    }))
      saved.set(entry.item, entry.baseline);
    host.adopt(WATCH_OWNER, (item) => watches.adopt(item, sessionId, saved.get(item.id)));
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
        const recorded = recordFetched(ref, fetched, toolCall);
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
    // git_pr_status and git_pr_watch record what they read themselves, including through nested MCP calls.
    if (OWN_READS.has(event.toolName)) return;
    if (event.parentToolCallId && ownCalls.has(event.parentToolCallId)) return;
    try {
      const observations = await observe(event as ToolResultLike, { cwd: ctx.cwd, resolveRepo });
      if (observations.length === 0) return;
      const agentId = tree.node()?.agentId;
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
              createdBy: tree.node()?.agentId,
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
        "To wait for CI, a review or a merge, call git_pr_watch and end your turn; do not poll git_pr_status.",
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
        const access = mcpAccess(ctx, signal);
        const agentId = tree.node()?.agentId;
        ownCalls.add(id);
        let entries: StatusEntryValue[];
        try {
          entries = await readAndRecord(
            refs,
            { tool: "git_pr_status", toolCallId: id, ...(agentId ? { agentId } : {}) },
            { signal, ...access },
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

  pi.registerTool(
    defineTool({
      name: "git_pr_watch",
      label: "Git PR Watch",
      description:
        "Wait on a pull request without polling: reads it from GitHub on a timer while you end your turn, and wakes you with a message when something needs you. " +
        "Reports, each with the head commit it is for: checks finished on the head (with the names of failed checks), the head moved (someone pushed), the review decision changed, reviews or comments were added, it now conflicts with its base, and it was merged or closed. " +
        'until "settled" (default) ends the watch when checks finish on the head; until "merged" keeps it open through every report until the pull request is merged or closed. It also ends at timeoutSeconds. ' +
        "The watch is open work: it keeps a subagent waiting, and survives a reload or resume. One watch per pull request: calling it again continues the same watch from the status it returns, so your own push or reply is not reported back to you. " +
        "A session watches a limited number at a time (the maxWatches setting, default 10). stop: true cancels the watch. " +
        "Reads through gh when it is installed and signed in, otherwise through the GitHub MCP pull_request_read tool; after a reload, through gh only. Never writes to GitHub.",
      promptSnippet:
        "Wait on a pull request and be woken when its checks, reviews or state change.",
      promptGuidelines: [
        "Use git_pr_watch to wait for a pull request's CI, a review or its merge, then end your turn: its message wakes you. Do not poll git_pr_status or build a job_watch for it.",
        "After you push to a watched pull request or reply on it, call git_pr_watch again before ending your turn, so the watch continues from the new head.",
      ],
      parameters: Type.Object({
        pr: Type.String({
          description:
            "A pull request URL, owner/repo#number, or a number in the current repository.",
        }),
        until: Type.Optional(
          Type.Union([Type.Literal("settled"), Type.Literal("merged")], {
            description:
              'When the watch ends: "settled" once checks finish on the head (default), "merged" once it is merged or closed.',
          }),
        ),
        timeoutSeconds: Type.Optional(
          Type.Integer({
            minimum: MIN_TIMEOUT_SECONDS,
            maximum: MAX_TIMEOUT_SECONDS,
            description: `End the watch after this long. Default ${DEFAULT_TIMEOUT_SECONDS}.`,
          }),
        ),
        stop: Type.Optional(
          Type.Boolean({ description: "Stop watching this pull request. Default false." }),
        ),
      }),
      annotations: { openWorldHint: true },
      async execute(id, params, signal, _update, ctx) {
        try {
          const repo = /^#?\d+$/.test(params.pr.trim()) ? await resolveRepo(ctx.cwd) : undefined;
          const ref = parsePrTarget(params.pr, repo);
          if (!ref)
            throw new Error(
              `"${params.pr}" is not a pull request URL, owner/repo#number, or a number in this repository`,
            );
          const key = prKey(ref);
          const label = prLabel(ref);
          const existing = watches.get(key);
          const reply = (text: string, watching: boolean, entry?: StatusEntryValue) => ({
            content: [{ type: "text" as const, text }],
            details: { watching, ...(watches.get(key) ? { watch: watches.get(key) } : {}), entry },
          });
          if (params.stop === true)
            return reply(
              watches.stop(key) ? `Stopped watching ${label}.` : `${label} was not being watched.`,
              false,
            );
          const { maxWatches } = getConfig();
          if (!existing && watches.size >= maxWatches)
            throw new Error(
              `${maxWatches} pull requests are already watched (the maxWatches setting); stop one first (git_pr_list names them)`,
            );

          const access = mcpAccess(ctx);
          const started = generation;
          // Nested MCP reads of this call and of the watch it starts are recorded here, once.
          ownCalls.add(id);
          let fetched: Fetched;
          try {
            fetched = await readStatus(ref, { signal, ...mcpAccess(ctx, signal) });
          } catch (error) {
            ownCalls.delete(id);
            throw error;
          }
          signal?.throwIfAborted();
          if (started !== generation) throw new Error("the session changed while reading it");
          const agentId = tree.node()?.agentId;
          const recorded = recordFetched(
            ref,
            fetched,
            { tool: "git_pr_watch", toolCallId: id, ...(agentId ? { agentId } : {}) },
            true,
          );
          const url = recorded?.url ?? prUrl(ref);
          const entry: StatusEntryValue = {
            key,
            label,
            url,
            ...(fetched.title ? { title: fetched.title } : {}),
            ...pickFacts(fetched.facts),
            ciDone: checksSettled(fetched.facts),
            source: fetched.source,
          };
          const status = prStatusText([entry]);
          const until: WatchUntil = params.until ?? existing?.until ?? "settled";
          // Nothing left to wait for: say so now instead of waking the session for it.
          const over =
            fetched.facts.state === "merged" || fetched.facts.state === "closed"
              ? `it is ${fetched.facts.state}`
              : until === "settled" && entry.ciDone
                ? `checks already finished on head ${(fetched.facts.headSha ?? "unknown").slice(0, 12)}`
                : undefined;
          if (over) {
            watches.stop(key);
            ownCalls.delete(id);
            const hint =
              fetched.facts.state === "open" || fetched.facts.state === undefined
                ? ' If that is not the commit you pushed, GitHub has not caught up: call git_pr_watch again. To wait for reviews or the merge instead, pass until: "merged".'
                : "";
            return reply(`Not watching ${label}: ${over}.${hint}\n${status}`, false, entry);
          }

          if (existing && existing.until === until && params.timeoutSeconds === undefined) {
            if (access) bindAccess(key, id, access);
            else ownCalls.delete(id);
            watches.rebase(key, fetched);
            return reply(
              `Already ${describeWatch(existing, now())}; it continues from this status. End your turn: a message wakes you.\n${status}`,
              true,
              entry,
            );
          }
          // A changed `until` or timeout replaces the watch.
          watches.stop(key);
          const deadline = now() + (params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
          let opened;
          try {
            opened = watches.open({
              ref,
              url,
              until,
              deadline,
              callId: id,
              sessionId: ctx.sessionManager.getSessionId(),
              reading: fetched,
            });
          } catch (error) {
            ownCalls.delete(id);
            throw error;
          }
          bindAccess(key, id, access);
          return reply(
            `Now ${describeWatch(opened, now())}. End your turn: a message wakes you when checks finish, the head moves, a review or comment arrives, or it is merged or closed.\n${status}`,
            true,
            entry,
          );
        } catch (error) {
          throw new Error(`git_pr_watch: ${errorText(error)}`);
        }
      },
    }),
  );

  /**
   * Hand a PR to the user for review at `head`, from facts just read and
   * recorded. Records nothing unless they show it open at exactly that head.
   * Kept apart from the tool so a tool that opens a PR can hand it off too.
   */
  const handOff = (
    ref: PrRef,
    head: string,
    fetched: Fetched,
    reason?: string,
  ): { requested: boolean; row: ReviewRow; replaced?: ReviewRow } => {
    const label = prLabel(ref);
    const { state, headSha, draft } = fetched.facts;
    if (state !== "open")
      throw new Error(`${label} is ${state ?? "in a state GitHub did not report"}, not open`);
    if (!headSha) throw new Error(`GitHub did not report ${label}'s head commit`);
    if (headSha.toLowerCase() !== head.toLowerCase())
      throw new Error(
        `${label}'s head is ${headSha.slice(0, 12)} on GitHub, not ${head.slice(0, 12)}: check what is pushed, then request review at that head`,
      );
    const key = prKey(ref);
    const existing = reviews.get(key);
    if (existing?.state === "ready" && existing.request.head === head.toLowerCase())
      return { requested: false, row: existing };
    const entry: ReviewRequest = {
      v: ATTENTION_VERSION,
      kind: "request",
      key,
      host: ref.host,
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      head: head.toLowerCase(),
      ...(draft === true ? { draft: true } : {}),
      ...(reason ? { reason } : {}),
      at: now(),
    };
    if (!isAttentionEntry(entry))
      throw new Error(`${label} cannot be recorded: its identity is too long`);
    recordIntent(entry);
    return { requested: true, row: reviews.get(key)!, ...(existing ? { replaced: existing } : {}) };
  };

  /** Whether a watch keeps a handed-off PR's request current, and the call that would. */
  const watchAdvice = (ref: PrRef): string => {
    const watch = watches.get(prKey(ref));
    if (watch?.until === "merged")
      return "git_pr_watch is watching it until it is merged or closed, so the request follows it while this session runs.";
    const call = `git_pr_watch { pr: "${prUrl(ref)}", until: "merged" }`;
    return watch
      ? `The watch on it ends when checks finish: call ${call} so the request follows it until it is merged or closed.`
      : `No git_pr_watch is open on it: call ${call} so the request follows it while this session runs. Without one, nothing updates the request until the pull request is read again.`;
  };

  pi.registerTool(
    defineTool({
      name: "git_pr_request_review",
      label: "Git PR Request Review",
      description:
        "Hand a pull request to the user for review at the head commit you checked. Reads it from GitHub once and records the request only if it is open at exactly that head; never writes to GitHub. " +
        "The user sees it as waiting on them (bb, the dashboard, /attention) until they approve it, mark it ready for review (when it was a draft), merge or close it, or dismiss it. A push after the request marks it stale: request again at the new head once it is ready. " +
        "Asking again for the same head while it waits records nothing. It does not watch the pull request: its result says when no git_pr_watch keeps the request current. Main session only.",
      promptSnippet: "Hand a pull request to the user for review at the head you checked.",
      promptGuidelines: [
        "Call git_pr_request_review when a pull request is ready for the user to review, with the full head SHA you checked. Green checks alone are not a handoff.",
        'Keep a git_pr_watch with until: "merged" on a pull request you hand to the user, so the request follows it; git_pr_request_review says when there is none.',
      ],
      parameters: Type.Object({
        pr: Type.String({
          description:
            "A pull request URL, owner/repo#number, or a number in the current repository.",
        }),
        head: Type.String({
          description: "The full 40-character SHA of the head commit you checked and hand off.",
        }),
        reason: Type.Optional(
          Type.String({
            description: `What the user is reviewing, in a few words, e.g. the roadmap step. At most ${MAX_REQUEST_REASON} characters.`,
          }),
        ),
      }),
      annotations: { openWorldHint: true },
      async execute(id, params, signal, _update, ctx) {
        try {
          if (tree.node()?.parent !== undefined)
            throw new Error(
              "only the main session hands pull requests to the user. Report it to the delegating agent instead.",
            );
          const head = params.head.trim();
          if (!FULL_SHA.test(head))
            throw new Error(
              `"${params.head}" is not a full commit SHA: pass the 40-character head SHA you checked`,
            );
          const repo = /^#?\d+$/.test(params.pr.trim()) ? await resolveRepo(ctx.cwd) : undefined;
          const ref = parsePrTarget(params.pr, repo);
          if (!ref)
            throw new Error(
              `"${params.pr}" is not a pull request URL, owner/repo#number, or a number in this repository`,
            );
          if (!isPrIdentity(ref))
            throw new Error(`"${params.pr}" does not name a pull request on GitHub`);
          const label = prLabel(ref);
          const reason = sanitizeLine(params.reason ?? "")
            .trim()
            .slice(0, MAX_REQUEST_REASON);
          const details = (requested: boolean, row: ReviewRow) => ({
            requested,
            key: row.request.key,
            head: row.request.head,
            state: row.state,
            ...(watches.get(row.request.key)
              ? { watching: watches.get(row.request.key)!.until }
              : {}),
          });
          // Already waiting on the user at this head: nothing to read or record.
          const waiting = reviews.get(prKey(ref));
          if (waiting?.state === "ready" && waiting.request.head === head.toLowerCase())
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Review of ${label} at ${head.slice(0, 12)} is already requested; nothing recorded.\n${watchAdvice(ref)}`,
                },
              ],
              details: details(false, waiting),
            };

          const started = generation;
          ownCalls.add(id);
          let fetched: Fetched;
          try {
            fetched = await readStatus(ref, { signal, ...mcpAccess(ctx, signal) });
          } finally {
            ownCalls.delete(id);
          }
          signal?.throwIfAborted();
          if (started !== generation) throw new Error("the session changed while reading it");
          const agentId = tree.node()?.agentId;
          recordFetched(
            ref,
            fetched,
            { tool: "git_pr_request_review", toolCallId: id, ...(agentId ? { agentId } : {}) },
            true,
          );
          const outcome = handOff(ref, head, fetched, reason || undefined);
          const at = outcome.row.request.head.slice(0, 12);
          const until = outcome.row.request.draft
            ? "they mark it ready for review, approve, merge or close it, or dismiss it"
            : "they approve, merge or close it, or dismiss it";
          const again =
            outcome.replaced?.state === "stale"
              ? ` (the request at ${outcome.replaced.request.head.slice(0, 12)} was stale)`
              : "";
          const text = outcome.requested
            ? `Requested review of ${label} at ${at}${again}. It waits on the user until ${until}; a push makes it stale.`
            : `Review of ${label} at ${at} is already requested; nothing recorded.`;
          return {
            content: [{ type: "text" as const, text: `${text}\n${watchAdvice(ref)}` }],
            details: details(outcome.requested, outcome.row),
          };
        } catch (error) {
          throw new Error(`git_pr_request_review: ${errorText(error)}`);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "git_pr_ready",
      label: "Git PR Ready",
      description:
        "Mark pull requests the user reviewed as ready for review and, with autoMerge, turn on auto-merge, in one call for 1 to " +
        `${MAX_READY} pull requests. Each is pinned to the head the user reviewed: it is read first and refused when its head on GitHub is another commit, and auto-merge through gh is given that head as well. ` +
        "head defaults to the head of the review request (git_pr_request_review) waiting on the user for it; with neither, the pull request is refused. " +
        "A pull request already ready for review, or with auto-merge already on, counts as done. One that fails does not stop the others. " +
        'autoMerge: true uses the repository\'s default merge method; "squash", "merge" or "rebase" picks one. When nothing is left to wait for, GitHub cannot turn auto-merge on, so the pull request is merged at once at that head. ' +
        "Each is read again afterwards and recorded; a review request waiting on the user for that head is resolved. Writes through gh when it is signed in, otherwise the GitHub MCP tools. Main session only.",
      promptSnippet:
        "Mark reviewed pull requests ready for review and turn on auto-merge, pinned to the reviewed heads.",
      promptGuidelines: [
        "When the user says pull requests they reviewed can go, call git_pr_ready once with all of them, instead of gh pr ready, gh pr merge or the GitHub MCP tools one by one.",
        "Give git_pr_ready the head the user reviewed: the one you showed them or handed off with git_pr_request_review. Never pass a head the user has not seen.",
        'To follow marked pull requests to the merge, call git_pr_watch with until: "merged" for each.',
      ],
      parameters: Type.Object({
        prs: Type.Array(
          Type.Object({
            pr: Type.String({
              description:
                "A pull request URL, owner/repo#number, or a number in the current repository.",
            }),
            head: Type.Optional(
              Type.String({
                description:
                  "The full 40-character SHA of the head the user reviewed. Default: the head of the review request waiting on the user for it.",
              }),
            ),
          }),
          { minItems: 1, maxItems: MAX_READY },
        ),
        ready: Type.Optional(
          Type.Boolean({
            description: "Mark each ready for review when it is a draft. Default true.",
          }),
        ),
        autoMerge: Type.Optional(
          Type.Union([Type.Boolean(), ...MERGE_METHODS.map((method) => Type.Literal(method))], {
            description:
              'Turn on auto-merge: true for the repository\'s default merge method, or "squash", "merge" or "rebase". Default false.',
          }),
        ),
      }),
      outputSchema: ReadyOutput,
      annotations: { openWorldHint: true },
      async execute(id, params, signal, _update, ctx) {
        try {
          if (tree.node()?.parent !== undefined)
            throw new Error(
              "only the main session marks pull requests ready: what ships is the user's decision. Report them to the delegating agent instead.",
            );
          const markReady = params.ready !== false;
          const autoMerge = params.autoMerge ?? false;
          if (!markReady && autoMerge === false)
            throw new Error("nothing to do: pass ready: true, autoMerge, or both");
          const method = typeof autoMerge === "string" ? autoMerge : undefined;
          const started = generation;
          const ensureCurrent = () => {
            signal?.throwIfAborted();
            if (started !== generation) throw new Error("the session changed while marking them");
          };
          const access = toolAccess(ctx, signal);
          const reader = access ? findPullRequestReader(access.names) : undefined;
          const readOptions = {
            ...(signal ? { signal } : {}),
            ...(access && reader ? { reader, runTool: access.runTool } : {}),
          };
          let gh: PrWriter | undefined;
          let mcp: PrWriter | undefined;
          // Write the way the read went: gh when it answered, the MCP tools otherwise.
          const writerFor = (source: string): PrWriter => {
            if (source === "gh")
              return (gh ??= ghWriter(dependencies.runGh ?? realGh, {
                ...(signal ? { signal } : {}),
                ...(dependencies.retry ? { retry: dependencies.retry } : {}),
              }));
            if (!access)
              throw new Error("gh cannot answer and this call cannot reach the GitHub MCP tools");
            return (mcp ??= mcpWriter(findPullRequestWriters(access.names), access.runTool, {
              ...dependencies.retry,
              ...(signal ? { signal } : {}),
            }));
          };
          let here: Promise<Omit<PrRef, "number"> | undefined> | undefined;
          const agentId = tree.node()?.agentId;
          const toolCall = {
            tool: "git_pr_ready",
            toolCallId: id,
            ...(agentId ? { agentId } : {}),
          };

          const markOne = async (entry: ReadyEntryValue, ref: PrRef, given: string | undefined) => {
            const key = entry.key;
            const pending = reviews.get(key);
            if (given !== undefined && !FULL_SHA.test(given))
              throw new Error(
                `"${given}" is not a full commit SHA: pass the 40-character head SHA the user reviewed`,
              );
            const head = (given || pending?.request.head)?.toLowerCase();
            if (!head)
              throw new Error(
                "no head given and no review request waits on the user for it: pass the full head SHA the user reviewed",
              );
            entry.head = head;
            const fetched = await readStatus(ref, readOptions);
            ensureCurrent();
            recordFetched(ref, fetched, toolCall, true);
            const { state, headSha, draft } = fetched.facts;
            if (state !== "open")
              throw new Error(`it is ${state ?? "in a state GitHub did not report"}, not open`);
            if (!headSha) throw new Error("GitHub did not report its head commit");
            if (headSha.toLowerCase() !== head)
              throw new Error(
                `its head is ${headSha.slice(0, 12)} on GitHub, not ${head.slice(0, 12)}: it changed since that review, so show the user the new head`,
              );
            const writer = writerFor(fetched.source);
            if (markReady) {
              if (draft === false) entry.ready = "already";
              else {
                await writer.ready(ref);
                ensureCurrent();
                entry.ready = "marked";
              }
            }
            if (autoMerge !== false) {
              if (fetched.autoMerge === true) entry.autoMerge = "already";
              else {
                const done = await writer.autoMerge(ref, head, method);
                ensureCurrent();
                entry.autoMerge = done.outcome;
                if (done.method) entry.method = done.method;
              }
            }
            // Read it again: record what it is now, and catch a push that raced the writes.
            let after: Fetched | undefined;
            try {
              after = await readStatus(ref, readOptions);
            } catch (error) {
              ensureCurrent();
              entry.note = `It could not be read again to confirm: ${errorText(error)}`;
            }
            if (after) {
              ensureCurrent();
              recordFetched(ref, after, toolCall, true);
              if (after.facts.state) entry.state = after.facts.state;
              if (after.facts.state === "merged" && entry.autoMerge === "enabled")
                entry.autoMerge = "merged";
              const moved = after.facts.headSha?.toLowerCase();
              if (after.facts.state === "open" && moved && moved !== head) {
                const short = moved.slice(0, 12);
                const prefix = `its head moved to ${short} while it was being marked`;
                if (entry.autoMerge !== "enabled")
                  throw new Error(`${prefix}: show the user the new head`);
                let off = false;
                try {
                  if (writer.disableAutoMerge) {
                    await writer.disableAutoMerge(ref);
                    off = true;
                  }
                } catch {
                  ensureCurrent();
                }
                if (off) {
                  delete entry.autoMerge;
                  delete entry.method;
                  throw new Error(
                    `${prefix}, so auto-merge was turned off again: show the user the new head`,
                  );
                }
                throw new Error(
                  `${prefix}, and auto-merge is still on: turn it off unless the user reviews ${short}`,
                );
              }
            }
            // Marked at the head handed to the user: the request waiting on them is done.
            const waiting = reviews.get(key);
            if (pending?.state === "ready" && pending.request.head === head) {
              if (waiting?.state === "ready" && waiting.request.head === head)
                recordIntent({
                  v: ATTENTION_VERSION,
                  kind: "dismissal",
                  key,
                  head,
                  at: now(),
                });
              entry.dismissed = true;
            }
          };

          const entries: ReadyEntryValue[] = [];
          const seen = new Set<string>();
          ownCalls.add(id);
          try {
            for (const item of params.prs) {
              ensureCurrent();
              const bare = /^#?\d+$/.test(item.pr.trim());
              const ref = parsePrTarget(
                item.pr,
                bare ? await (here ??= resolveRepo(ctx.cwd)) : undefined,
              );
              if (!ref || !isPrIdentity(ref)) {
                entries.push({
                  key: "",
                  label: item.pr,
                  url: "",
                  error:
                    "not a pull request URL, owner/repo#number, or a number in this repository",
                });
                continue;
              }
              const key = prKey(ref);
              if (seen.has(key)) continue;
              seen.add(key);
              const entry: ReadyEntryValue = {
                key,
                label: prLabel(ref),
                url: prs.get(key)?.url ?? prUrl(ref),
              };
              entries.push(entry);
              try {
                await markOne(entry, ref, item.head?.trim() || undefined);
              } catch (error) {
                ensureCurrent();
                entry.error = errorText(error);
              }
            }
          } finally {
            ownCalls.delete(id);
          }
          const text = prReadyText(entries);
          // Every one failed: the call failed, with what each did before it failed.
          if (entries.every((entry) => entry.error)) throw new Error(text);
          return {
            content: [{ type: "text" as const, text }],
            details: { prs: entries },
            structuredContent: { prs: entries },
          };
        } catch (error) {
          throw new Error(`git_pr_ready: ${errorText(error)}`);
        }
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
      output.show(ctx, sanitizeText(lines.join("\n")), failed.length ? "warning" : "info");
    },
  });

  pi.registerCommand("git:prs", {
    description:
      "Browse the pull requests this session opened or looked at, with the last status its tools showed",
    handler: async (_args, ctx) => {
      const current = snapshot();
      const at = now();
      if (ctx.mode !== "tui") {
        output.show(ctx, prListText(current.prs, true, at), "info");
        return;
      }
      await showExplorer(ctx, prExplorerView(current.prs, at), {
        fallback: () => prListText(current.prs, true, at),
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
        output.show(ctx, sanitizeText(`Could not check worktrees: ${errorText(error)}`), "warning");
      }
      if (args.trim() === "remove") {
        await removeInteractively(ctx);
        return;
      }
      const current = snapshot();
      if (ctx.mode !== "tui") {
        output.show(ctx, listText(current, false), "info");
        return;
      }
      await showExplorer(ctx, explorerView(current), {
        fallback: () => listText(current, false),
      });
    },
  });

  const removeInteractively = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) {
      output.show(
        ctx,
        "Removing a worktree needs a dialog to pick one and confirm; ask the agent to use git_worktree_remove.",
        "warning",
      );
      return;
    }
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
      output.show(ctx, "No worktrees to remove.", "info");
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
      output.show(ctx, sanitizeText(`${picked.path} is no longer a worktree.`), "warning");
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
      output.show(
        ctx,
        sanitizeText(`Removed ${record.path}; branch ${record.branch} is kept.${unpushed}`),
        "info",
      );
    } catch (error) {
      output.show(
        ctx,
        sanitizeText(`Could not remove ${record.path}: ${errorText(error)}`),
        "error",
      );
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

function resolvePath(cwd: string, path: string): string {
  return resolve(cwd, path);
}
