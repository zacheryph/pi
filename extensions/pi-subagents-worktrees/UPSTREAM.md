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

Still byte-for-byte with upstream: `README.md`, `CHANGELOG.md`, `LICENSE`, `docs/`,
and every file under `src/` and `test/` except those named under **Local changes**
below (`src/index.ts`, `src/config.ts`, `src/workspace-provider.ts`,
`test/index.test.ts`) and the new `test/session-services.test.ts`.

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

### Register per session

The bundled pi-subagents publishes its service on `session_start`, one per session,
and `getSubagentsService()` without an id returns the outermost session's. Upstream
registered its provider at extension load with that lookup, so here it found no
service (nothing is published yet at load) and never registered. In a child it
would have found the parent's service, which already has a provider and throws.

- `src/index.ts`: registers on `session_start` with
  `getSubagentsService(ctx.sessionManager.getSessionId())`, replacing its own
  earlier registration if the session starts again, and unregisters on
  `session_shutdown`. The rescue notices run in the same handler. The
  `/subagents-worktrees` command is now registered even when no service exists.
- `test/index.test.ts`: registration tests drive `session_start`; added a re-start
  test; the "service unavailable" test now expects the command and handlers.
- `test/session-services.test.ts` (new): a parent and a child session, each with a
  service in the real registry; each registers with its own, and the child's
  shutdown leaves the parent's provider in place. Fails against upstream's
  load-time lookup.
- `scripts/verify-bundle.mjs`: asserts the `/subagents-worktrees` command.

## Known gaps

- Opt-in only: with no `subagents-worktrees.json`, `worktreeAgents` is empty and
  every child runs in the parent's directory, exactly as before this import.
- Upstream was tested against `@gotgenes/pi-subagents` 16.4–21.4; the vendored
  fork is based on 23.2.0. The `WorkspaceProvider` seam and `loadLayeredSettings`
  typecheck unchanged against it.
- The rescue commit (`src/worktree.ts`) runs a plain `git commit`, so it follows
  the repository's and the user's Git config. With `commit.gpgsign=true` and a
  key that needs a prompt, it can fail or time out; the worktree is then
  preserved, not lost. Not changed yet.

## Sync history

| Date       | Upstream commit   | Notes           |
| ---------- | ----------------- | --------------- |
| 2026-10-31 | `62924b0` (0.3.3) | Initial import. |

## Shared Oxc and TypeScript 7 tooling

Source, tests, and documentation follow the bundle's formatting and lint rules.
Private import maps target explicit `.ts` files. Tests use those package-local
maps instead of a global `#src` alias, which redirected the sibling subagents
service's imports into this workspace and broke its session-services tests.
