# pi-git

Git worktrees an orchestrator creates in any repository and hands to subagents,
recorded in the session ledger.

A worktree here belongs to whoever created it, not to a subagent run: it stays
until it is removed with `git_worktree_remove` or `/git:worktrees remove`.
Subagents come and go; the next one continues in the same directory.

## Tools

| Tool                  | What it does                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `git_worktree_create` | `{ branch, repo?, base?, workspace? }`. Creates a worktree and returns the path to pass as `cwd` to `subagent_start`.                                                          |
| `git_worktree_list`   | `{ includeRemoved? }`. This session's worktrees with repository, branch, workspace, the subagents that ran there, and git status. Read-only.                                   |
| `git_worktree_remove` | `{ path, force? }`. Removes a worktree; the branch is always kept. Refuses when removal would lose work (uncommitted changes, or commits on a detached `HEAD`) unless `force`. |

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
  Worktrees under the root that the ledger does not name (another session's)
  are listed separately and can still be removed.

## Command

`/git:worktrees` opens a browser with **This session**, **Removed** and
**Other** tabs; Enter shows a worktree's details. Outside the interactive
terminal it prints the list. `/git:worktrees remove` picks a worktree to remove
and asks for confirmation, naming any work removal would lose.

## Events

`git:snapshot` on the session's `pi.events` bus: `{ version: 1, worktrees, found }`.
`worktrees` are this session's records, newest first, each with its last
measured `status` (`dirty`, `detached`, `unpushed`, `merged`) or `error`.
`found` are worktrees under the root the ledger does not name. Emitted on
session start, `/tree`, every ledger change, and each status refresh.

## Configuration

`~/.pi/agent/git.json`, overridden by the project's `.pi/git.json`:

```json
{ "worktreeRoot": "~/.pi/agent/worktrees" }
```

`worktreeRoot` holds every worktree pi-git creates. `~/` expands to the home
directory; a relative path is relative to the session's cwd. Default:
`<agent dir>/worktrees`.
