---
name: new-extension
description: Create a new first-party Pi extension in this repository's bundle. A script scaffolds extensions/<name>/ from templates and registers it in the root manifest and the bundle check; the skill then covers the README entry and the session, UI, config and test conventions to implement it by. Use when adding a new extension, a new tool or command that belongs in its own extension, or a new shared library under packages/. For copying a third-party extension, use import-extension instead.
---

# Add a new extension

Every extension is its own npm workspace under `extensions/<name>/`, loaded by
Pi through an explicit entry in the root `package.json`. Nothing is built or
published: Pi loads the TypeScript source directly.

Before starting, check that no existing extension already owns the tool or
command you want. Extend that one instead when it does.

## 1. Scaffold

Install root development dependencies with `npm install --ignore-scripts`, then run
from the repository root:

```bash
node .agents/skills/new-extension/scripts/scaffold.mjs pi-<topic> \
  --description "<one line: what it does>" \
  --tool <snake_name> --command <name> \
  --after <pi-extension-it-needs-first>
```

| Option                | Effect                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-<topic>`          | Directory and package name; lowercase, hyphenated.                                                                                                                                       |
| `--description`       | Required. Used in `package.json`, the factory's doc comment, and the extension's README.                                                                                                 |
| `--tool`, `--command` | Repeatable. Each gets a stub registration, a test, and an assertion in `scripts/verify-bundle.mjs`. A name another extension already uses is refused. Adding a tool also adds `typebox`. |
| `--after`             | Load after that extension (Pi runs `session_start` handlers in load order). Default: last.                                                                                               |
| `--settings`          | `global` or `layered`: also create `src/config.ts` with a `defineSettings` definition of that scope and a placeholder field.                                                             |
| `--no-tui`            | Leave out `@earendil-works/pi-tui` when the extension renders nothing.                                                                                                                   |
| `--no-install`        | Skip `npm install --ignore-scripts`; the lockfile is then stale until you run it. CI uses `npm ci`, so commit the updated lockfile.                                                      |

It checks everything before writing anything, then:

- creates `package.json` (using the root's shared development tools),
  `tsconfig.json`, `vitest.config.ts`, `README.md`, `src/index.ts`,
  `test/index.test.ts` and, with `--settings`, `src/config.ts` from `templates/`;
- adds the workspace and the `pi.extensions` entry to the root `package.json`;
- adds the tools and commands to the lists `scripts/verify-bundle.mjs` asserts;
- runs `npm install --ignore-scripts` (unless skipped), then formats the generated
  workspace and edited root files with Oxfmt.

Review `git diff` afterwards. Then add it to the root README (step 2), implement
the stubs (step 3), and extend the tests (step 4).

Keep helper modules beside `src/index.ts`; only the entry point is registered.
Import siblings by relative path. Use `#src/*` aliases only with matching
`imports` and `paths` entries, as `extensions/pi-todo` has. A runtime dependency
goes in the **root** `dependencies`, since a Git install of the bundle installs
only those; nested manifests alone expose nothing.

## 2. Add it to the root README

The script leaves the root `README.md` to you:

- **Layout tree:** add `extensions/<name>/` with its entry point and `test/`,
  in name order, matching the neighbors' rails and `# comments`.
- **Extensions section:** add `### <name>` in name order: what it does, its tools
  and commands, its config files, and a link to `extensions/<name>/README.md`.
  Write it for a user of the bundle; implementation detail belongs in the
  extension's own README.

## 3. Follow the runtime conventions

**Sessions.** Every subagent is a full in-process Pi session that loads every
bundle extension again. So:

- Keep all state in the factory's closure, never in module scope: a same-cwd
  child may share the parent's module instance.
- Rebuild state in `restore` (the template wires it to `session_start` and
  `session_tree`) from your entries with `readEntries(ctx, { type, guard })`
  from [`packages/pi-session-state`](../../../packages/pi-session-state/README.md),
  and persist with `pi.appendEntry`, so `/tree`, resume, reload and compaction
  work.
- To give the model state it may have lost after a compaction, reload, resume
  or `/tree`, use `contextCard(pi, { type, restore, build })` from the same
  package. `restore` says whether there is state to bring back after those
  events; call the returned `hide()` once the model has seen it. The helper
  strips the old card, appends the new one and tracks whether it is shown.
- Guard UI with `ctx.hasUI`; children have none.
- A captured `ctx` goes stale after reload. Re-read it from each event.
- To offer a service to other sessions, use `treeService(pi, name, api)` from
  `packages/pi-session-state`: it follows the session's children, provides on
  `session_start`, withdraws on `session_shutdown`, and `tree.parent(fn)` calls
  the parent's copy. For anything else across sessions, use
  `packages/pi-session-tree` (`call`, `ancestors`) by relative path. Never put a
  bare object on `globalThis`.

**Talking to other extensions.** Publish state on the session's `pi.events` bus
as `<name>:<event>` (see `pi-todo:snapshot`, `pi-stash:snapshot`), with a
version field. pi-dashboard and others subscribe there.

**Configuration.** Declare settings once in `src/config.ts` with `defineSettings`
from `packages/pi-foundations/src/settings.ts` (`--settings` scaffolds it; see
`extensions/pi-todo/src/config.ts`). `name: "<topic>"` reads
`<agent dir>/<topic>.json`; `scope: "layered"` adds the project override
`.pi/<topic>.json`, `"global"` is for state every project shares. Each field
names its validation and default (`bool`, `int`, `number`, `oneOf`, `string`,
`optional`, `list`, `record`), and `SettingsOf<typeof xSettings>` is the loaded type, so write no
separate interface, defaults object or sanitizer, and never read the file
yourself. `load(ctx.cwd)` never throws: malformed files and invalid fields warn
and fall back to defaults. `writable: true` adds `save(cwd, patch)` for a
settings command. Call `load` behind a `dependencies.loadConfig` seam so tests
can pass a config without files.

**Tools.** Replace the stub `description` and `promptGuidelines`; define real
`parameters`. Keep output bounded (Pi caps at 50 KB / 2,000 lines; stay well
under). Set `annotations.readOnlyHint: true` on tools that only read, so pi-job
can watch them.

**Terminal UI.** Follow `AGENTS.md`: at least one space of padding on both sides
of every body row, subtract padding before layout and truncation, blank rows
when the width cannot fit padding plus content. Fullscreen views use a centered
overlay; regular mode uses a custom screen (see `extensions/pi-system-insights`).

## 4. Test it

- Use [`packages/pi-test-helpers`](../../../packages/pi-test-helpers/README.md)
  before writing a local helper: temp directories, polling, themes, padding
  assertions, `ui.custom` mounting and SDK sessions are there.
- `test/index.test.ts` starts with its `fakePi`, which records `on`,
  `registerTool` and `registerCommand`. Drive handlers with `emit`, tools with
  `runTool` and commands with `runCommand` (more examples:
  `extensions/pi-tldr/test/index.test.ts`).
- Rendering: test narrow widths, ANSI-colored text and wide Unicode, and assert
  the padding rules (`expectPadded`, `NARROW_WIDTHS`, `WIDE_TEXT`, `ansiTheme`).
- Anything that persists or crosses sessions: one SDK test with Pi's real
  `DefaultResourceLoader`, `createAgentSession` and the faux provider (see
  `extensions/pi-stash/test/sdk.test.ts`, built on the helpers' `fauxSession`).
  It runs offline.

## 5. Verify and open the PR

```bash
npm run check -w extensions/<name>
npm test -w extensions/<name>
npm run verify:bundle
```

Then `/reload` in Pi to try it; a local checkout needs no reinstall. Commit with
`git -c commit.gpgsign=false commit`. In the PR, list the tools and commands
added and what `verify:bundle` now asserts.

## Shared libraries

Code that several extensions import goes in `packages/<name>/` instead: a
workspace with no `pi` manifest entry, so Pi never loads it as an extension.
Add it to `workspaces` only; extensions import it by relative path. CI re-tests
every workspace when a package changes. See `packages/pi-session-state/`. The
scaffold script does not cover packages.

## Changing the templates

`templates/` holds the files the script renders; `{{name}}`, `{{description}}`,
`{{factory}}`, `{{imports}}`, `{{registrations}}`, `{{registrationTests}}` and
`{{surface}}` are filled in, and `templates/snippets/` holds the per-tool and
per-command blocks. An unknown `{{variable}}` stops the script. After changing a
template, scaffold a throwaway extension and run step 5 on it.
