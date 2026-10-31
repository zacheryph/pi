---
name: new-extension
description: Create a new first-party Pi extension in this repository's bundle. A script scaffolds extensions/<name>/ from templates and registers it in the root manifest and the bundle check; the skill then covers the README entry and the session, UI, config and test conventions to implement it by. Use when adding a new extension, a new tool or command that belongs in its own extension, or a new shared library under packages/. For copying a third-party extension, use vendor-extension instead.
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
| `--no-tui`            | Leave out `@earendil-works/pi-tui` when the extension renders nothing.                                                                                                                   |
| `--no-install`        | Skip `npm install --ignore-scripts`; the lockfile is then stale until you run it. CI uses `npm ci`, so commit the updated lockfile.                                                      |

It checks everything before writing anything, then:

- creates `package.json` (using the root's shared development tools),
  `tsconfig.json`, `vitest.config.ts`, `README.md`, `src/index.ts` and
  `test/index.test.ts` from `templates/`;
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
  `session_tree`) from `ctx.sessionManager.getBranch()`, and persist with
  `pi.appendEntry`, so `/tree`, resume, reload and compaction work.
- Guard UI with `ctx.hasUI`; children have none.
- A captured `ctx` goes stale after reload. Re-read it from each event.
- To reach another session (parent or child), use
  `packages/pi-session-tree` (`provide`, `call`, `ancestors`) by relative path.
  Never put a bare object on `globalThis`.

**Talking to other extensions.** Publish state on the session's `pi.events` bus
as `<name>:<event>` (see `pi-todo:snapshot`, `pi-stash:snapshot`), with a
version field. pi-dashboard and others subscribe there.

**Configuration.** Global file `~/.pi/agent/<topic>.json` via `getAgentDir()`,
optional project override `.pi/<topic>.json`, sanitized field by field with
defaults for anything missing or invalid (see `extensions/pi-todo/src/config.ts`).
Never throw on a malformed file; warn and use defaults.

**Tools.** Replace the stub `description` and `promptGuidelines`; define real
`parameters`. Keep output bounded (Pi caps at 50 KB / 2,000 lines; stay well
under). Set `annotations.readOnlyHint: true` on tools that only read, so pi-jobs
can watch them.

**Terminal UI.** Follow `AGENTS.md`: at least one space of padding on both sides
of every body row, subtract padding before layout and truncation, blank rows
when the width cannot fit padding plus content. Fullscreen views use a centered
overlay; regular mode uses a custom screen (see `extensions/pi-system-insights`).

## 4. Test it

- `test/index.test.ts` starts with a fake `pi` that records `on`,
  `registerTool` and `registerCommand`. Extend it to drive the handlers and the
  tools' `execute` (more examples: `extensions/pi-tldr/test/index.test.ts`).
- Rendering: test narrow widths, ANSI-colored text and wide Unicode, and assert
  the padding rules.
- Anything that persists or crosses sessions: one SDK test with Pi's real
  `DefaultResourceLoader`, `createAgentSession` and the faux provider (see
  `extensions/pi-stash/test/sdk.test.ts`). It runs offline.

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
every workspace when a package changes. See `packages/pi-session-tree/`. The
scaffold script does not cover packages.

## Changing the templates

`templates/` holds the files the script renders; `{{name}}`, `{{description}}`,
`{{factory}}`, `{{imports}}`, `{{registrations}}`, `{{registrationTests}}` and
`{{surface}}` are filled in, and `templates/snippets/` holds the per-tool and
per-command blocks. An unknown `{{variable}}` stops the script. After changing a
template, scaffold a throwaway extension and run step 5 on it.
