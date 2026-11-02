# Vendored pi-subagents-worktrees

Git worktree isolation for pi-subagents children, imported from
[`gotgenes/pi-packages/packages/pi-subagents-worktrees`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents-worktrees).

|                      |                                                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source               | https://github.com/gotgenes/pi-packages                                                                                                                                                             |
| Directory            | `packages/pi-subagents-worktrees`                                                                                                                                                                   |
| Commit               | `62924b0a8389eed41c4da93b0bf0ea89e0b5c794` (2026-09-05, "chore(release): pi-subagents 21.4.1, pi-subagents-worktrees 0.3.3") — the last commit touching this directory as of `98ee0a1` (2026-10-27) |
| Upstream version     | `@gotgenes/pi-subagents-worktrees` 0.3.3                                                                                                                                                            |
| Upstream tested with | Pi 0.79.1, `@gotgenes/pi-subagents` 16.4+, Node.js 22                                                                                                                                               |
| License              | MIT; original notice retained in `LICENSE`                                                                                                                                                          |
| Imported             | 2026-10-31                                                                                                                                                                                          |

This is an editable source copy, not a Git submodule or npm runtime dependency.
The root bundle exposes `src/index.ts`, listed right after pi-subagents in
`pi.extensions` so the subagents service exists first. Install the root bundle;
do not also install `npm:@gotgenes/pi-subagents-worktrees`.

## Import

Partially cloned upstream outside this repository (sparse checkout of the package
directory) and copied every tracked file under `packages/pi-subagents-worktrees`
with `git ls-files | tar --strip-components=2`. Left out `AGENTS.md`: it only tells
agents to relaunch Pi from the upstream monorepo root, which would mislead agents
working in this repository. The first commit on the import branch is that copy
alone; `diff -r` against the clone showed no differences.

Upstream's `CHANGELOG.md` was cleared; its history up to the import is in the
[source changelog](https://github.com/gotgenes/pi-packages/blob/62924b0a8389eed41c4da93b0bf0ea89e0b5c794/packages/pi-subagents-worktrees/CHANGELOG.md).
Local changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## Sync history

| Date       | Upstream commit   | Notes           |
| ---------- | ----------------- | --------------- |
| 2026-10-31 | `62924b0` (0.3.3) | Initial import. |
