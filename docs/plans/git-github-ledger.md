# Git and GitHub ledger: worktrees and pull requests

Status: research · Pi SDK checked: `@earendil-works/pi-coding-agent` 1.4.0

## Goal

- The orchestrator creates worktrees, in one repository or several, and hands them
  to subagents. A worktree lives until someone removes it, not until a subagent
  is cleaned up.
- Every worktree and pull request a session touches is recorded in that session's
  ledger (its JSONL, via `pi.appendEntry`). The ledger survives `/reload`, resume
  and compaction.
- `/git:*` commands list them after a reload, with their last known state.
- The dashboard shows them on the session card and its detail page.
- Checking a PR's status, reviews or checks with **any** tool (`gh` in bash, the
  GitHub MCP tools, a tool of our own) records the PR and what was observed. PRs
  the session opened and PRs it only looked at are kept apart. A subagent's PRs
  land in its parent's ledger too.

Non-goals for a first version: moving your own session into a worktree (see
"Other extensions"), a general GitHub client, polling GitHub in the background.

## What worktrees need here

The orchestrator decides where each worker runs, so a worktree must:

- **Outlive the run.** A worker that finishes or is released leaves its
  worktree, so the orchestrator can resume it there or start another worker in
  the same place.
- **Be chosen per task, not per agent type.** Two workers can share one; another
  gets a fresh one on its own branch.
- **Work in any repository,** and across several in one task, not only the
  parent's working directory.
- **Use a named branch** that is pushed and opened as a PR as usual.
- **Live outside `$TMPDIR`,** which the OS clears on its own schedule.
- **Never be deleted while its state is uncertain,** and be reconciled against
  git on session start.

## Candidates

All are MIT. Line counts exclude tests.

| Package                                                          | What it is                                                                                                                                         | Persists in session                                         | Fit                                                                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@gotgenes/pi-github-tools` 6.1.0 (~1,000 lines)                 | `ci_find`, `ci_watch`, `ci_list`, `issue_close`. Shells out to `gh`; retries transient read failures.                                              | No                                                          | Poor. See below.                                                                                            |
| `pi-prs` 0.6.0 (mavam, ~4,000 lines)                             | Resolves the **current branch's** PR, polls every 30 s, footer widgets, `/pr watch` sends new review threads and CI failures as turns.             | Yes: watch target and delivered feedback ids, branch-scoped | Best prior art for the ledger. One PR at a time, its own poller, depends on `pi-fancy-footer` and turndown. |
| `@narumitw/pi-github-pr` / `@signalridge/pi-github-pr`           | Current-branch PR status in the status line. No tools, no commands.                                                                                | No                                                          | Display only.                                                                                               |
| `@henryqw/pi-pr` 11.2 (~9,800 lines)                             | Full `/pr` workflow: commit, publish, sweep feedback, fix CI, merge with confirmation; nine tools, seven skills.                                   | Own lock files                                              | Too large and opinionated; needs `pi-herdr`, `pi-process`.                                                  |
| `@mholtzscher/pi-github-tools`                                   | `/pr`, `/pr-comments`, `/pr-actions`, `/pr-review` commands.                                                                                       | No                                                          | Commands for a personal workflow; no state.                                                                 |
| `@narumitw/pi-worktree`, `pi-worktree-extension`, `pi-worktrunk` | Move **your own** session between worktrees (create, switch, resume per task).                                                                     | Session files per worktree                                  | Different problem. Possible later addition.                                                                 |
| `@senad-d/branchme` (~15,700 lines)                              | Git branch, worktree, commit, push, PR tools, plus a repo snapshot in every system prompt. `create_worktree` returns a `handoff.cwd` for a caller. | No                                                          | Far too broad, but its "create, verify, hand the path over" worktree shape is the one wanted here.          |

### Why not vendor `@gotgenes/pi-github-tools`

- `ci_watch` and `ci_find` **block the turn** while they poll. This bundle already
  chose the opposite model: `job_watch` / `job_start` wake the agent and the agent
  ends its turn (`skills/babysit-pr`).
- They key on a workflow file name. `babysit-pr` already watches every check run
  on the head SHA.
- No PR tools at all, and no state.
- Worth taking: `src/lib/retry.ts`, its transient-error classifier (5xx,
  `no server is currently available`, transport errors; never 4xx or mutations).
  Copy it with attribution.

### Why not vendor `pi-prs`

Its persistence is done right (latest custom entry, ids of already-delivered
feedback so a resume does not repeat it). But it tracks exactly one PR, the
current branch's, and its core is a background poller that starts turns, which
overlaps `babysit-pr` + `job_watch`. Take its patterns, not the package.

## Recommendation: a first-party `pi-git`

One new extension owns worktrees, the ledger, the PR observer, the `/git:*`
commands and the dashboard snapshot. One small change to the vendored
pi-subagent lets the orchestrator hand a worktree to a subagent.

```text
orchestrator ── git_worktree_create ──▶ pi-git ── git worktree add ──▶ ~/.pi/agent/worktrees/…
     │                                    │
     └─ subagent_start { cwd } ──▶ child  ├─▶ appendEntry("git:ledger", …)
                                   │      ├─▶ pi.events "git:snapshot" ─▶ pi-dashboard
         any tool_result (gh, MCP) ┤      └─▶ /git:worktrees, /git:prs
         child's pi-git ── pi-session-tree adopt ──▶ parent's ledger
```

### Worktrees, owned by the orchestrator

Tools (any session may call them; a child's records are adopted by its parent):

- `git_worktree_create { repo?, branch, base?, workspace? }`
  - `repo`: a path to any git repository, relative to the session's cwd (default:
    the cwd's repository). This is what makes several repositories work.
  - `branch`: a real, named branch (`feat/login`), created from `base` (default:
    the repository's current `HEAD`). An existing branch is checked out instead,
    so a later worker can pick up where an earlier one stopped.
  - `workspace`: a name that groups worktrees from several repositories in one
    directory, see below.
  - Returns the path to give a subagent as `cwd`, and records the worktree.
- `git_worktree_list` reads the ledger, reconciled against git.
- `git_worktree_remove { path, force? }` refuses when the worktree has uncommitted
  changes or commits not on any remote, unless `force`. It never deletes the
  branch.

Location: `~/.pi/agent/worktrees/<workspace-or-repo>/<repo>-<branch>` by default,
`worktreeRoot` in `~/.pi/agent/git.json` (project `.pi/git.json` overrides).
Outside every repository, never in `$TMPDIR`.

**Several repositories in one task.** A workspace is a directory whose children
are worktrees of different repositories:

```text
~/.pi/agent/worktrees/auth-rework/
├── api/        # git worktree of ~/src/api on feat/auth-rework
└── web/        # git worktree of ~/src/web on feat/auth-rework
```

The orchestrator creates one worktree per repository with the same `workspace`,
then starts the subagent with `cwd` set to the workspace directory. The child
sees both repositories side by side, and each commits, pushes and opens its PR
on its own.

**Handing it to a subagent.** `subagent_start` gains an optional `cwd`. The core
already accepts a working-directory override (`AssemblerOptions.cwd` in
`src/session/session-config.ts`, used today only by the workspace provider); the
tool parameter feeds it when no provider supplies one. A local change to the
vendored pi-subagent with a `CHANGELOG.md` entry. pi-git sees the call
(`tool_call`) and the child's creation (`subagent:session:created`), and records
which agent used which worktree. Because no provider owns the directory, nothing
is disposed when the run ends and **resume keeps working**. When a worker is
released, the orchestrator starts a new one with the same `cwd`; the continuity
is in the worktree and the ledger, not the subagent.

**Reconciliation.** On `session_start`, every worktree record is checked against
git: still on disk, branch merged into its base, branch pushed, PR open (from the
PR records), or removed outside Pi. Nothing is deleted automatically.

**Open question:** dependency setup. A fresh worktree has no `node_modules`. An
optional per-repository `setup` command in `git.json` (for example `npm ci`),
run by `git_worktree_create` as a `job_start` job, is one answer.

### Ledger

Append-only custom entries, folded on `session_start` and `session_tree`, like
pi-stash and pi-todo:

```ts
type GitLedgerEntry =
  | {
      v: 1;
      kind: "pr";
      key: string; // "github.com/owner/repo#123"
      url: string;
      origin: "created" | "referenced";
      via: { tool: string; toolCallId: string; agentId?: string };
      status?: PrStatus;
      at: number;
    }
  | {
      v: 1;
      kind: "worktree";
      path: string;
      repo: string; // main repository path
      branch: string;
      base: string; // ref and SHA it was created from
      workspace?: string;
      agents: string[]; // agent ids that ran in it
      todo?: string; // pi-todo key, when the orchestrator passes one
      state: "active" | "merged" | "removed" | "missing";
      at: number;
    };

interface PrStatus {
  state: "open" | "closed" | "merged";
  draft?: boolean;
  review?: "approved" | "changes_requested" | "review_required";
  checks?: { passed: number; failed: number; pending: number };
  mergeable?: boolean;
  headSha?: string;
  observedAt: number;
  source: "gh" | "mcp" | "tool-output";
}
```

Read with `getEntries()`, **not** `getBranch()`. A worktree that was created or a
PR that was opened stays so when you `/tree` back past the call; stash and todo
are branch-scoped because they are working notes, these are external side
effects.

A new session starts with an empty ledger. Worktrees under `worktreeRoot` that no
record names are still listed by `/git:worktrees` (as "not from this session"),
so nothing is lost when a session ends. A per-repository index of PRs across
sessions can come later.

### Observing PRs from any tool

A `tool_result` handler sees every call's tool name, input and output, including
MCP tools and nested codemode calls. It does no I/O; it only extracts PR
references:

| Source                                                                                                        | Extract                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `bash` running `gh pr create`                                                                                 | PR URL in the output → `origin: "created"`.                                                                                   |
| `bash` running `gh pr view/checks/status/merge/review/ready/edit/comment`, `gh api repos/O/R/pulls/N…`        | Number or URL from the command (`-R`, or the remote of the command's directory); `--json` output parsed into `PrStatus`.      |
| `mcp__github__create_pull_request`                                                                            | `number`, `html_url` from the result → `created`.                                                                             |
| `mcp__github__pull_request_read`, `update_pull_request`, `merge_pull_request`, `pull_request_review_write`, … | Generic rule: a GitHub tool whose input has `owner`, `repo`, `pullNumber` (or `pull_number`). Parse status from JSON results. |
| Anything else                                                                                                 | `https://<host>/<owner>/<repo>/pull/<n>` URLs in input or output → `referenced`.                                              |

A PR first seen as `referenced` becomes `created` if a later call shows this
session (or one of its subagents) opened it. `/git:prs` and the dashboard show
**Opened here** and **Referenced** as separate groups.

The observer records what the output already said and does not parse free text
into status. The reliable status read is pi-git's own:
`gh pr view <n> --json state,isDraft,reviewDecision,statusCheckRollup,mergeable,headRefOid`,
or `pull_request_read` when only MCP is available, as in cloud sessions.

### `git_pr_status` tool

Read-only: given a PR (or none, for every open PR in the ledger), fetch fresh
status, record it, return it. `babysit-pr` and the model call it to check a PR,
and `job_watch` can poll it as a `toolCheck`
(`match: { path: "checks.pending", equals: 0 }`). It records from inside
`execute`, so it lands in the ledger even if a `toolCheck` call made through
`executeTool` emits no `tool_result` event (to verify).

### Subagents

A child's pi-git records in the child's ledger and hands each record to its parent
through `packages/pi-session-tree`, the way pi-stash adopts entries
(`call(parent, "pi-git", (s) => s.adopt(record))`). The dashboard shows only
top-level sessions, so without this a PR a worker opened would not appear there.

### Commands

pi-ui explorers, fullscreen TUI:

- `/git:worktrees`: worktrees grouped by workspace, with repository, branch,
  agents, linked PR and state; Enter shows details. Removal from here asks for
  confirmation and uses the same refusals as `git_worktree_remove`.
- `/git:prs`: **Opened here** and **Referenced**, each with number, title,
  state, review, checks and the age of the observation; Enter shows details and
  the tool calls that touched it.
- `/git:refresh`: re-read every open PR and reconcile every worktree.

### Dashboard

pi-git emits `git:snapshot` (`{ version: 1, prs, worktrees }`) on
`session_start`, `session_tree` and every change, like `todo:snapshot`.
pi-dashboard gets a `readGit()` in `src/sections.ts` (defensive, bounded), a
`GitSection` in `src/protocol.ts`, card counts (worktrees, open PRs, failing
checks), and a detail-page section with the two PR groups and the worktrees.

## Steps

Each is shippable alone.

1. **`cwd` on `subagent_start`** (vendored pi-subagent): optional, must be an
   existing directory, passed as the session's working-directory override when no
   workspace provider supplies one. Recorded on the agent so resume uses it.
   `CHANGELOG.md` entry, tests for spawn and resume.
2. **Scaffold `pi-git`** with the `new-extension` skill: ledger and restore,
   `git_worktree_create/list/remove`, workspaces, reconciliation,
   `/git:worktrees`, `git:snapshot`. SDK test with the real loader for reload and
   resume; tests with two repositories.
3. **PR observer:** `tool_result` extraction for bash/`gh`, GitHub MCP tools and
   URLs; the two groups; `/git:prs`; adoption from children. Table-driven tests
   from captured outputs.
4. **Status:** `git_pr_status` and `/git:refresh`, `gh` first, MCP fallback,
   retry classifier copied from pi-github-tools with attribution.
5. **Dashboard:** `git:snapshot` reader, card counts, detail section.
6. **Orchestrator and skills:** the `orchestrator` profile creates a worktree per
   implementation task (or a workspace when the task spans repositories) and
   passes `cwd`; `babysit-pr` uses `git_pr_status`; `execute-roadmap` uses
   worktrees for parallel steps instead of requiring non-overlapping files.

Run `make-it-easy` on this document to turn it into a roadmap under
`docs/roadmaps/` once the dependency-setup question is answered.
