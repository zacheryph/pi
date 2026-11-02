# Changelog

Local changes to this vendored copy, newest first. Where it came from is
recorded in [UPSTREAM.md](UPSTREAM.md).

## 2026-11-01: Identifiers (#59)

Renamed to this bundle's `resource:name` grammar. The directory and package
moved from `extensions/pi-subagents-worktrees` (`@gotgenes/pi-subagents-worktrees`)
to `extensions/pi-subagent-worktree` (`pi-subagent-worktree`), dropping the
double plural.

- Command: `/subagents-worktrees` became `/subagent:worktrees` (it lists the
  preserved worktrees, a collection).
- Settings file: `subagents-worktrees.json` became `subagent-worktree.json`.
- Diagnostic labels read `pi-subagent-worktree`.
- The `pi-agent-` worktree and branch prefix is unchanged, so worktrees preserved
  before the rename are still listed.

## 2026-10-31: Shared Oxc and TypeScript 7 tooling (#42)

- Source, tests, and documentation follow the bundle's formatting and lint rules.
- Private import maps target explicit `.ts` files. Tests use those package-local
  maps instead of a global `#src` alias, which redirected the sibling subagents
  service's imports into this workspace and broke its session-services tests.

## 2026-10-31: Register per session (#33)

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
- `scripts/verify-bundle.mjs`: asserts the `/subagent:worktrees` command.

## 2026-10-31: Integration (#33)

- `package.json`: marked `private`; removed `publishConfig`, `bugs`, and the
  `lint` script (it needs upstream's monorepo Biome/ESLint configs).
- `package.json`: replaced `catalog:` dev dependency versions with the bundle's
  pins (Pi 1.4.0, TypeScript 6, Vitest 5, `@types/node` 24); Pi is a `"*"` peer;
  engines follow the bundle's Node.js 24 floor; `UPSTREAM.md` added to `files`.
- `package.json`: dropped the `@gotgenes/pi-subagents` peer and dev dependency.
  The three imports of it now point at the vendored copy by relative path, as
  pi-subagents asks of companion extensions, because a Git-installed bundle has
  no `@gotgenes/pi-subagents` package to resolve:
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
- Known gap: opt-in only. With no `subagents-worktrees.json`, `worktreeAgents` is
  empty and every child runs in the parent's directory, exactly as before this
  import.
- Known gap: upstream was tested against `@gotgenes/pi-subagents` 16.4–21.4; the
  vendored fork is based on 23.2.0. The `WorkspaceProvider` seam and
  `loadLayeredSettings` typecheck unchanged against it.
- Known gap: the rescue commit (`src/worktree.ts`) runs a plain `git commit`, so
  it follows the repository's and the user's Git config. With
  `commit.gpgsign=true` and a key that needs a prompt, it can fail or time out;
  the worktree is then preserved, not lost.

## 2026-10-31: Vendored

Imported from upstream; see [UPSTREAM.md](UPSTREAM.md). Upstream's changelog was
cleared at import; for earlier history see the
[source changelog](https://github.com/gotgenes/pi-packages/blob/62924b0a8389eed41c4da93b0bf0ea89e0b5c794/packages/pi-subagents-worktrees/CHANGELOG.md).
