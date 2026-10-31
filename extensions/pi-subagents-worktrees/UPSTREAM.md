# Vendored pi-subagents-worktrees

Git worktree isolation for pi-subagents children, imported from
[`gotgenes/pi-packages/packages/pi-subagents-worktrees`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents-worktrees).

| | |
| --- | --- |
| Source | https://github.com/gotgenes/pi-packages |
| Directory | `packages/pi-subagents-worktrees` |
| Commit | `62924b0a8389eed41c4da93b0bf0ea89e0b5c794` (2026-09-05, "chore(release): pi-subagents 21.4.1, pi-subagents-worktrees 0.3.3") — the last commit touching this directory as of `98ee0a1` (2026-10-27) |
| Upstream version | `@gotgenes/pi-subagents-worktrees` 0.3.3 |
| Upstream tested with | Pi 0.79.1, `@gotgenes/pi-subagents` 16.4+, Node.js 22 |
| License | MIT; original notice retained in `LICENSE` |
| Imported | 2026-10-31 |

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

Still byte-for-byte with upstream: `README.md`, `CHANGELOG.md`, `LICENSE`, `docs/`,
and every file under `src/` and `test/` except those named under **Local changes**
below (`src/index.ts`, `src/config.ts`, `src/workspace-provider.ts`,
`test/index.test.ts`).

## Local changes

### Integration (import PR)

- `package.json`: marked `private`; removed `publishConfig`, `bugs`, and the
  `lint` script (it needs upstream's monorepo Biome/ESLint configs).
- `package.json`: replaced `catalog:` dev dependency versions with the bundle's
  pins (Pi 1.4.0, TypeScript 6, Vitest 5, `@types/node` 24); Pi is a `"*"` peer;
  engines follow the bundle's Node.js 24 floor; `UPSTREAM.md` added to `files`.
- `package.json`: dropped the `@gotgenes/pi-subagents` peer and dev dependency.
  The three imports of it now point at the vendored copy by relative path, as
  pi-subagents' `UPSTREAM.md` asks of companion extensions, because a
  Git-installed bundle has no `@gotgenes/pi-subagents` package to resolve:
  - `src/index.ts`, `src/workspace-provider.ts`: `@gotgenes/pi-subagents` →
    `../../pi-subagents/src/service/service.ts`.
  - `src/config.ts`: `@gotgenes/pi-subagents/settings` →
    `../../pi-subagents/src/layered-settings.ts`.
  - `test/index.test.ts`: the matching `vi.mock` path.
- `package.json` `imports` (here and in `extensions/pi-subagents`): each `#src/*`
  and `#test/*` target gained a `types` condition (`./src/*.ts`) beside the
  unchanged `default`. `tsconfig.json` dropped its `paths`, which applied this
  package's `#src` mapping to pi-subagents' files too; TypeScript now resolves
  each package's `#src` from its own manifest. Runtime resolution is unchanged.
- `vitest.config.ts`: added `root`, like the bundle's other workspaces.
- Root `package.json`: added the workspace and the `pi.extensions` entry.

## Known gaps

- Opt-in only: with no `subagents-worktrees.json`, `worktreeAgents` is empty and
  every child runs in the parent's directory, exactly as before this import.
- Upstream was tested against `@gotgenes/pi-subagents` 16.4–21.4; the vendored
  fork is based on 23.2.0. The `WorkspaceProvider` seam and `loadLayeredSettings`
  typecheck unchanged against it.

## Sync history

| Date | Upstream commit | Notes |
| --- | --- | --- |
| 2026-10-31 | `62924b0` (0.3.3) | Initial import. |
