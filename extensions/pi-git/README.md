# pi-git

Git worktrees an orchestrator creates in any repository and hands to subagents,
and the pull requests the session opens or looks at, recorded in the session
ledger.

A worktree here belongs to whoever created it, not to a subagent run: it stays
until it is removed with `git_worktree_remove` or `/git:worktrees remove`.
Subagents come and go; the next one continues in the same directory.

## Tools

| Tool                  | What it does                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `git_worktree_create` | `{ branch, repo?, base?, workspace? }`. Creates a worktree and returns the path to pass as `cwd` to `subagent_start`.                                                          |
| `git_worktree_list`   | `{ includeRemoved? }`. This session's worktrees with repository, branch, workspace, the subagents that ran there, and git status. Read-only.                                   |
| `git_worktree_remove` | `{ path, force? }`. Removes a worktree; the branch is always kept. Refuses when removal would lose work (uncommitted changes, or commits on a detached `HEAD`) unless `force`. |
| `git_pr_list`         | `{ includeReferenced? }`. The pull requests this session opened or looked at, with the last status a tool showed for each. Read-only; reads the ledger, not GitHub.            |

`git_worktree_create`:

- `repo`: any repository, absolute or relative to the session's cwd. Default: the
  repository the session is in. A path inside a linked worktree means its main
  repository.
- `branch`: checked out as it is when it exists locally, or on exactly one
  remote; otherwise created from `base` (default: the repository's `HEAD`).
  `base` is refused for a branch that already exists.
- `workspace`: groups worktrees of several repositories in one directory. Create
  one per repository with the same `workspace`, then give the subagent the
  workspace directory as `cwd`; it sees each repository side by side.

```text
<worktree root>/
├── api/feat-login/      # git_worktree_create { repo: "api", branch: "feat/login" }
└── auth-rework/         # workspace "auth-rework": the subagent's cwd
    ├── api/             # git_worktree_create { repo: "api", branch: "auth", workspace: "auth-rework" }
    └── web/             # git_worktree_create { repo: "web", branch: "auth", workspace: "auth-rework" }
```

Removal never deletes a branch, so committed work is never lost by it, pushed or
not; the list and the removal result say when a branch holds commits no remote
has. Nothing is removed automatically.

## Ledger

Each change appends a `git:ledger` custom entry holding the whole record: path,
repository, branch, base, workspace, the subagent ids that ran there, and state
(`active`, `missing`, `removed`). The latest entry per path wins. Records are
read from every branch of the session, not only the current one: a worktree
exists on disk whether or not `/tree` moves back past the call that made it.
Reload, resume and compaction keep them.

- A subagent's ids are recorded from pi-subagent's `subagent:session:created`
  event, which carries the child's `cwd`: a child started in a worktree, below
  it, or in its workspace directory is added to it.
- A worktree a subagent creates is handed up to its parent's ledger (and on to
  the root) through `packages/pi-session-tree`, marked as adopted with the
  creating subagent's id.
- On session start, `/tree`, `git_worktree_list` and `/git:worktrees`, each
  record is checked against disk. One deleted outside Pi becomes `missing`.
  Worktrees under the root that the ledger does not name (another session's,
  including one recreated at a path this session removed) are listed separately
  and can still be removed.
- Adopting a subagent's change keeps the agents this session recorded on that
  worktree, which the subagent never saw.
- Untracked files count as uncommitted changes even when
  `status.showUntrackedFiles` hides them.

## Pull requests

Every tool result is checked for pull requests; nothing else about the call
changes. A PR is recorded as **opened here** (`created`) when the session, or
one of its subagents, opened it, and as **referenced** when it only looked at
it:

| Source                                                                                           | What is recorded                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gh pr create` in bash                                                                           | The URL it printed, opened here.                                                                                                                                                                                                                   |
| `gh pr view/checks/merge/review/ready/edit/comment/close/reopen/diff` in bash                    | The PR named by URL, by number (repository from `-R`, links in the output, or the `origin` remote), or the current branch's PR from the output. Status from `--json` output, `gh pr view`'s plain output, `gh pr checks` rows, and merge messages. |
| `gh api repos/<owner>/<repo>/pulls/<n>[/reviews]` in bash                                        | The PR, with state, draft, head and title from the object, or the review decision from the reviews.                                                                                                                                                |
| GitHub tools (`mcp__github__*`, or any tool named github) with `owner`, `repo` and a pull number | The PR, with status from a PR object, check runs, combined status, reviews or a merge result. `create_pull_request` records the URL it returned as opened here.                                                                                    |
| Any other tool                                                                                   | A pull request URL in its input, referenced. A `job_watch` that polls a GitHub tool for a PR counts too.                                                                                                                                           |

Output of other commands and tools is never scanned, so a `git log` or a file
that mentions PRs records nothing. A failed call records nothing, except
`gh pr checks`, which exits 1 when a check failed and 8 while checks are
pending: its rows (or `--json` output) still count when it listed any checks.

Each record keeps the last status seen, field by field, and each field keeps
the time it was seen: a later check-runs read neither forgets an earlier
review nor makes an older state look new, so a subagent's checks read cannot
reopen a PR its parent saw merged. The record also keeps when and through which
tool it was last seen, and the last 20 tool calls that touched it, with the
subagent that made each.
pi-git never asks GitHub itself: check a PR again for fresh status. A PR seen in
a subagent is handed up to its parent, and opened-here wins when the two
disagree.

## Commands

- `/git:worktrees` opens a browser with **This session**, **Removed** and
  **Other** tabs; Enter shows a worktree's details. Outside the interactive
  terminal it prints the list. `/git:worktrees remove` picks a worktree to
  remove and asks for confirmation, naming any work removal would lose.
- `/git:prs` opens a browser with **Opened here** and **Referenced** tabs;
  Enter shows a PR's status, branch, when it was seen, and the tool calls that
  touched it. Outside the interactive terminal it prints the list.

## Events

`git:snapshot` on the session's `pi.events` bus:
`{ version: 1, worktrees, found, prs }`. `worktrees` are this session's
records, newest first, each with its last measured `status` (`dirty`,
`detached`, `unpushed`, `merged`) or `error`. `found` are worktrees under the
root the ledger does not name. `prs` are the pull request records, most
recently touched first. Emitted on session start, `/tree`, every ledger change,
and each status refresh.

## Configuration

`~/.pi/agent/git.json`, overridden by the project's `.pi/git.json`:

```json
{ "worktreeRoot": "~/.pi/agent/worktrees", "trackReferenced": true }
```

- `worktreeRoot` holds every worktree pi-git creates. `~/` expands to the home
  directory; a relative path is relative to the session's cwd. Default:
  `<agent dir>/worktrees`.
- `trackReferenced`: also record pull requests the session only looked at.
  Default `true`; with `false`, only PRs opened here are recorded.
