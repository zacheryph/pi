# Git and GitHub ledger: worktrees and pull requests

Status: research · Pi SDK checked: `@earendil-works/pi-coding-agent` 1.4.0

## Goal

- Every worktree and pull request a session touches is recorded in that session's
  ledger (its JSONL, via `pi.appendEntry`). The ledger survives `/reload`, resume
  and compaction.
- A command lists them after a reload, with their last known state.
- The dashboard shows them on the session card and its detail page.
- Checking a PR's status, reviews or checks with **any** tool (`gh` in bash, the
  GitHub MCP tools, a tool of our own) records the PR and what was observed.
  A subagent's PRs land in its parent's ledger too.

Non-goals for a first version: moving your own session into a worktree (see
"Other extensions" below), a general GitHub client, polling GitHub in the
background.

## How pi-subagent-worktree works today

It plugs into one seam in pi-subagent: the `WorkspaceProvider`
(`extensions/pi-subagent/src/lifecycle/workspace.ts`). Before every child run, the
subagent core asks the provider for a working directory. When the child finishes,
it calls `dispose()` on what the provider returned.

1. **Opt-in by agent type.** `~/.pi/agent/subagent-worktree.json` or
   `.pi/subagent-worktree.json` lists `worktreeAgents`. **Without that file it
   does nothing**: every child runs in your checkout.
2. **Prepare.** For an opted-in type it runs
   `git worktree add --detach $TMPDIR/pi-agent-<agentId>-<rand> HEAD` and the
   child runs there. The worktree starts from the parent's last **commit**:
   uncommitted changes in your checkout are not in it.
3. **Dispose.**
   - No changes: the worktree is removed. Nothing remains.
   - Changes: `git add -A`, `git commit -m "pi-agent: <description>"` (retried
     once with `--no-verify` if a hook rejects it), branch `pi-agent-<agentId>`
     at that commit, worktree removed. The child's result gets a note:
     `Changes saved to branch pi-agent-… Merge with: git merge …`.
   - Anything fails: the worktree is left on disk and the result says where.
   - A child waiting on a question keeps its worktree until it is resumed.
4. **Session start.** It scans git, not a record: rescue worktrees still under
   `$TMPDIR` and `pi-agent-*` branches not merged into `HEAD` each produce a
   warning. `/subagent:worktrees` lists the preserved worktrees and removes one
   after you confirm.

What it does **not** do: write anything to the session, push, open PRs, or know
which session or task a branch came from once the child's result has scrolled
away. Everything after the fact is rediscovered from git state, so there is no
history to show, and the dashboard cannot see it.

Two gotchas worth knowing:

- The rescue commit runs plain `git commit`, so it follows your Git config. With
  `commit.gpgsign=true` and a key that prompts, it fails and the worktree is
  preserved instead (recorded as a known gap in its `CHANGELOG.md`).
- A worktree from another Pi process on the same repository looks exactly like
  an abandoned one to `/subagent:worktrees`.

## Candidates

All are MIT. Line counts exclude tests.

| Package                                                          | What it is                                                                                                                                                                  | Persists in session                                         | Fit                                                                                                         |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@gotgenes/pi-github-tools` 6.1.0 (~1,000 lines)                 | `ci_find`, `ci_watch`, `ci_list`, `issue_close`. Shells out to `gh`; retries transient read failures.                                                                       | No                                                          | Poor. See below.                                                                                            |
| `pi-prs` 0.6.0 (mavam, ~4,000 lines)                             | Resolves the **current branch's** PR, polls every 30 s, footer widgets, `/pr watch` sends new review threads and CI failures as turns. Publishes `pi-prs:state` on the bus. | Yes: watch target and delivered feedback ids, branch-scoped | Best prior art for the ledger. One PR at a time, its own poller, depends on `pi-fancy-footer` and turndown. |
| `@narumitw/pi-github-pr` / `@signalridge/pi-github-pr`           | Current-branch PR status in the status line. No tools, no commands.                                                                                                         | No                                                          | Display only.                                                                                               |
| `@henryqw/pi-pr` 11.2 (~9,800 lines)                             | Full `/pr` workflow: commit, publish, sweep feedback, fix CI, merge with confirmation; nine tools, seven skills.                                                            | Own lock files                                              | Too large and opinionated; needs `pi-herdr`, `pi-process`.                                                  |
| `@mholtzscher/pi-github-tools`                                   | `/pr`, `/pr-comments`, `/pr-actions`, `/pr-review` commands.                                                                                                                | No                                                          | Commands for a personal workflow; no state.                                                                 |
| `@narumitw/pi-worktree`, `pi-worktree-extension`, `pi-worktrunk` | Move **your own** session between worktrees (create, switch, resume per task).                                                                                              | Session files per worktree                                  | Different problem from subagent isolation. Possible later addition, not part of this.                       |
| `@senad-d/branchme` (~15,700 lines)                              | Git branch, worktree, commit, push, PR tools, plus a repo snapshot in every system prompt.                                                                                  | No                                                          | Far too broad.                                                                                              |

### Why not vendor `@gotgenes/pi-github-tools`

- `ci_watch` and `ci_find` **block the turn** while they poll. This bundle already
  chose the opposite model: `job_watch` / `job_start` wake the agent and the agent
  ends its turn (`skills/babysit-pr`). Two ways to wait for CI invites the worse
  one.
- They key on a workflow file name. `babysit-pr` already watches every check run
  on the head SHA, which is what you want.
- No PR tools at all, and no state. Vendoring it moves the ledger goal not at all.
- Worth taking: `src/lib/retry.ts`, its transient-error classifier (5xx,
  `no server is currently available`, transport errors; never 4xx or mutations).
  Copy it with attribution into whatever reads GitHub.

### Why not vendor `pi-prs`

It is the closest in spirit and its persistence is done right (latest custom
entry on the branch, ids of already-delivered feedback so a resume does not
repeat it). But it tracks exactly one PR, the current branch's, and its core is a
background poller that starts turns, which overlaps `babysit-pr` + `job_watch`.
Take its patterns (bus API with a version field, dedupe by delivered id), not the
package.

## Recommendation

Build one first-party extension, **`pi-git`**, that owns the ledger, and keep
`pi-subagent-worktree` vendored with one small local change. Do not vendor either
GitHub package.

### Why not rename or merge pi-subagent-worktree

Renaming gives it a new name, not a memory. The provider is the right place to
_create_ worktrees, but it has no reason to know about PRs, and folding it into a
larger first-party extension ends upstream syncs for ~700 lines that work.
Instead, it publishes what it does, and `pi-git` records it. If you later diverge
from upstream anyway, merging it in is easy because the event boundary already
exists.

### Shape

```text
pi-subagent-worktree (vendored)          pi-git (new)
  prepare()  ──emit──▶ subagent-worktree:prepared ─┐
  dispose()  ──emit──▶ subagent-worktree:disposed ─┤
                                                    ├─▶ appendEntry("git:ledger", …)
  any tool_result (bash gh …, mcp github …) ───────┤      │
  pr_status tool (own) ────────────────────────────┘      ├─▶ pi.events "git:snapshot" ─▶ pi-dashboard
  child session's pi-git ── pi-session-tree adopt ─▶      └─▶ /pr, /worktree browsers (pi-ui)
```

**1. Ledger.** Append-only custom entries, folded on `session_start` and
`session_tree`, the same as pi-stash and pi-todo:

```ts
type GitLedgerEntry =
  | {
      v: 1;
      kind: "pr";
      key: string; // "github.com/owner/repo#123"
      url: string;
      origin: "created" | "referenced";
      via: { tool: string; toolCallId: string; agentId?: string };
      status?: PrStatus; // what was last observed, with `observedAt` and `source`
      at: number;
    }
  | {
      v: 1;
      kind: "worktree";
      agentId: string;
      path: string;
      branch?: string;
      baseSha: string;
      state: "active" | "clean" | "committed" | "preserved" | "merged" | "discarded";
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

Read it with `getEntries()`, **not** `getBranch()`. A PR that was opened stays
opened when you `/tree` back past the call; stash and todo are branch-scoped
because they are the agent's working notes, these are external side effects.

**2. Worktrees.** Record from the two new events. On `session_start`, reconcile
every non-final record against git: branch merged into `HEAD` → `merged`, branch
present → `committed`, worktree on disk → `preserved`, neither → `discarded`.
The `prepared` record is written before the child runs, so even a crash or a
dispose during shutdown (when nothing could be written) is reconciled on the next
start. The existing startup warnings and `/subagent:worktrees` keep working
unchanged.

**3. Observing PRs from any tool.** A `tool_result` handler sees the tool name,
its input and its output for every call, including MCP tools and nested codemode
calls (`parentToolCallId`). It does no I/O; it only extracts PR references:

| Source                                                                                                             | Extract                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `bash` running `gh pr create`                                                                                      | PR URL in the output → `origin: "created"`.                                                                                   |
| `bash` running `gh pr view/checks/status/merge/review/ready/edit/comment`, `gh api repos/O/R/pulls/N…`, `gh run …` | Number or URL from the command (`-R` or the cwd's remote for the repo); JSON output (`--json`) parsed into `PrStatus`.        |
| `mcp__github__create_pull_request`                                                                                 | `number`, `html_url` from the result → `created`.                                                                             |
| `mcp__github__pull_request_read`, `update_pull_request`, `merge_pull_request`, `pull_request_review_write`, …      | Generic rule: a GitHub tool whose input has `owner`, `repo`, `pullNumber` (or `pull_number`). Parse status from JSON results. |
| Anything else                                                                                                      | `https://<host>/<owner>/<repo>/pull/<n>` URLs in input or output.                                                             |

The observer only **discovers** and records what the output already said. It
should not try to parse free text into status. The one reliable status read is
`pi-git`'s own: `gh pr view <n> --json state,isDraft,reviewDecision,statusCheckRollup,mergeable,headRefOid`
(or `pull_request_read` when only MCP is available, as in cloud sessions).

**4. `pr_status` tool.** One read-only tool: given a PR (or none, for every open
PR in the ledger), fetch fresh status, record it, return it. It is what
`babysit-pr` and the model call to "check the PR", and because it is read-only it
also works as a `job_watch` `toolCheck` target (`match: { path: "checks.pending", equals: 0 }`).
It records from inside `execute`, so it is in the ledger even if a `toolCheck`
call made through `executeTool` emits no `tool_result` event (to verify).

**5. Subagents.** A child's `pi-git` records in the child's ledger and hands the
record to its parent through `packages/pi-session-tree`, the way pi-stash adopts
entries (`call(parent, "pi-git", s => s.adopt(record))`). The dashboard shows
only top-level sessions, so without this a PR a worker opened would not appear.
Worktree records need no adoption: the provider already runs in the parent.

**6. Commands** (pi-ui explorer, fullscreen TUI):

- `/pr` lists the ledger's PRs: number, title, state, review, checks, age of the
  observation; Enter shows details and the tool calls that touched it.
  `/pr:refresh` re-reads every open one.
- `/worktree` lists worktree records with their agent, description, branch and
  state, merged ones last. Removing a preserved worktree stays in
  `/subagent:worktrees` (or moves here later).

**7. Dashboard.** `pi-git` emits `git:snapshot` (`{ version: 1, prs, worktrees }`)
on `session_start`, `session_tree` and every change, like `todo:snapshot`.
pi-dashboard gets a `readGit()` in `src/sections.ts` (defensive, bounded), a
`GitSection` in `src/protocol.ts`, card counts (open PRs, failing checks,
unmerged branches), and a detail-page table with links.

**Ambiguity to settle:** should a PR that this session only _looked at_ (not
opened) be tracked? The schema handles both with `origin`. Suggested default:
record both; `/pr` and the dashboard show `created` first and `referenced` in a
second group. A setting (`git.json`: `trackReferenced`) can turn the second off.

**Not covered:** a new session starts with an empty ledger. If you want "every PR
I opened in this repo, across sessions", add a small per-repo index under
`~/.pi/agent/git/` later; the session ledger stays the source of truth.

## Steps

Each is shippable alone.

1. **Tidy (vendored):** pi-subagent-worktree emits
   `subagent-worktree:prepared { agentId, agentType, path, baseSha }` and
   `subagent-worktree:disposed { agentId, outcome, branch?, path?, hooksBypassed? }`
   on its session's `pi.events`. Behavior unchanged otherwise. `CHANGELOG.md`
   entry in the same commit. Consider fixing the GPG gap at the same time
   (`-c commit.gpgsign=false` on the rescue commit, matching `AGENTS.md`).
2. **Scaffold `pi-git`** with the `new-extension` skill (`--after pi-subagent-worktree`):
   ledger, restore, worktree records and reconciliation, `/worktree`, snapshot
   event. SDK test with the real loader for reload and resume.
3. **PR observer:** `tool_result` extraction for bash/`gh`, GitHub MCP tools and
   URLs; `/pr`; adoption from children. Table-driven tests from captured outputs.
4. **Status:** `pr_status` tool and `/pr:refresh`, `gh` first, MCP fallback,
   retry classifier copied from pi-github-tools with attribution.
5. **Dashboard:** `git:snapshot` reader, card counts, detail section.
6. **Skill:** `babysit-pr` uses `pr_status` (and `job_watch` on it) instead of raw
   `gh` status reads.

Run `make-it-easy` on this document to turn it into a roadmap under
`docs/roadmaps/` once the open question above is answered.
