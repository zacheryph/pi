/**
 * pi-git — git worktrees an orchestrator creates in any repository and hands to
 * subagents, recorded in the session ledger.
 *
 * Worktrees outlive the subagents that use them: pi-git creates them on named
 * branches under a configured root, records each in the session (`git:ledger`
 * entries, folded across every branch of the session), notes which subagents
 * ran in them, and removes them only when asked. A worktree a subagent creates
 * is handed up to its parent's ledger. State is published as `git:snapshot`.
 */

import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
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
import { loadGitConfig, type GitConfig } from "./config.ts";
import { GIT_SNAPSHOT_EVENT, snapshotEvent, type GitSnapshotEvent } from "./events.ts";
import { realPath, resolveCommit, type BaseRef, type WorktreeStatus } from "./git.ts";
import { foldLedger, isWorktreeRecord, LEDGER_TYPE, type WorktreeRecord } from "./ledger.ts";
import { explorerView, listText, statusText } from "./view.ts";
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
  /** Take a descendant's record into this ledger; false when it adds nothing new. */
  adopt(record: unknown): boolean;
}

export interface GitExtensionDependencies {
  loadConfig?: (cwd: string) => GitConfig;
  now?: () => number;
}

type Measured = { status: WorktreeStatus } | { error: string };
/** A worktree to act on, with the base its unsaved work is measured against. */
type Target = { record: WorktreeRecord; base: BaseRef };

export default function piGit(pi: ExtensionAPI, dependencies: GitExtensionDependencies = {}): void {
  // Per-session state lives in this closure, never in module scope: every
  // subagent session runs this factory again, and a same-cwd child may share
  // this module with its parent.
  const now = dependencies.now ?? Date.now;
  let records = new Map<string, WorktreeRecord>();
  let measured = new Map<string, Measured>();
  let found: FoundWorktree[] = [];
  let config: GitConfig | undefined;
  let cwd = process.cwd();
  let sessionId: string | undefined;
  let withdraw: (() => void) | undefined;
  /** Bumped on every session start and shutdown, so a stale refresh drops its results. */
  let generation = 0;

  trackChildren(pi);

  const getConfig = () => (config ??= (dependencies.loadConfig ?? loadGitConfig)(cwd));
  const snapshot = (): GitSnapshotEvent => snapshotEvent(records.values(), measured, found);
  const publish = () => pi.events.emit(GIT_SNAPSHOT_EVENT, snapshot());

  /** Hand a record to `from`'s parent, which adopts it and passes it on up. */
  const passUp = (from: string, record: WorktreeRecord) => {
    const parent = parentOf(from);
    if (parent) call<GitTreeService, boolean>(parent, SERVICE_NAME, (s) => s.adopt(record));
  };

  const append = (record: WorktreeRecord) => {
    pi.appendEntry<WorktreeRecord>(LEDGER_TYPE, record);
    records.set(record.path, record);
    publish();
    if (sessionId) passUp(sessionId, record);
  };

  const update = (record: WorktreeRecord, change: Partial<WorktreeRecord>) =>
    append({ ...record, ...change, updatedAt: Math.max(now(), record.updatedAt + 1) });

  const service: GitTreeService = {
    version: 1,
    adopt(candidate) {
      if (!isWorktreeRecord(candidate)) return false;
      const existing = records.get(candidate.path);
      // An older version never replaces a newer one. Sessions share one clock,
      // so an equal time is a change made in the same millisecond, kept only if
      // it changes something; that also ends any loop up the chain.
      if (existing && existing.updatedAt > candidate.updatedAt) return false;
      // Keep agents only this session saw run there: the child does not know them.
      const agents = existing
        ? [...existing.agents, ...candidate.agents.filter((id) => !existing.agents.includes(id))]
        : candidate.agents;
      const adopted: WorktreeRecord = { ...candidate, agents, via: "adopt" };
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

  const backgroundRefresh = (ctx: ExtensionContext) => {
    refresh().catch((error: unknown) => {
      if (ctx.hasUI)
        ctx.ui.notify(
          sanitizeText(`pi-git: could not check worktrees: ${errorText(error)}`),
          "warning",
        );
    });
  };

  /** Rebuild state from the session (start, resume, reload, /tree). */
  const restore = (ctx: ExtensionContext): void => {
    records = foldLedger(ctx.sessionManager.getEntries());
    measured = new Map();
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
  pi.on("session_shutdown", () => {
    generation += 1;
    withdraw?.();
    withdraw = undefined;
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

/** Equal apart from when and how the record arrived. */
function sameContent(a: WorktreeRecord, b: WorktreeRecord): boolean {
  const strip = ({ updatedAt: _at, via: _via, ...rest }: WorktreeRecord) => JSON.stringify(rest);
  return strip(a) === strip(b);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolvePath(cwd: string, path: string): string {
  return resolve(cwd, path);
}
