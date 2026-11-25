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

- creates `package.json` (using the root's shared development tools and configs),
  `README.md`, `src/index.ts`,
  `test/index.test.ts` and, with `--settings`, `src/config.ts` from `templates/`;
- adds the workspace and the `pi.extensions` entry to the root `package.json`;
- adds the tools and commands to the lists `scripts/verify-bundle.mjs` asserts;
- runs `npm install --ignore-scripts` (unless skipped), then formats the generated
  workspace and edited root files with Oxfmt.

Review `git diff` afterwards. Then document it (step 2), implement the stubs
(step 3), and extend the tests (step 4).

Keep helper modules beside `src/index.ts`; only the entry point is registered.
Use `#src/*` and `#test/*` for local source and test modules. The scaffold declares
them in the workspace's `package.json`, with `.ts` targets; do not duplicate them
in TypeScript `paths`. Shared aliases map to workspace packages, for example
`"#ui": "pi-ui"` or `"#foundations/*": "pi-foundations/*"` in the consuming
manifest. Their `exports` point to TypeScript source. A runtime dependency goes
in the **root** `dependencies` (`"pi-ui": "file:packages/pi-ui"` for a local
package), so Git installs create the links too. Relative TypeScript imports,
when needed for files outside these aliases, use `.ts`.

## 2. Document it

- **Root README:** add a row to the extension table: a link to
  `extensions/<name>/README.md`, what the user gets in one sentence, and the
  commands and tools they use it through. If it imports shared packages, add
  it to the "Who imports what" table, and to the diagrams if it publishes views
  or opens work items.
- **Its README:** the scaffold writes the shape every extension README has (see
  `AGENTS.md`, "READMEs"): a sentence on what it does, a screenshot, then
  **At a glance** bullets (what you see, what you type, what the agent calls)
  before any reference material. Fill in each `…`.
- **Screenshot:** add a scenario under
  `.agents/skills/tui-screenshot/scenarios/docs/`, an entry in
  `.agents/skills/tui-screenshot/scripts/docs-images.mjs`, and run it (see the
  tui-screenshot skill).

## 3. Follow the runtime conventions

Read "Extension runtime rules" in `AGENTS.md` first: state in the factory's
closure, persistence through `pi.appendEntry` and `readEntries`, one
`restoreCard` after compaction, no per-request `context` messages, `ctx.hasUI`
guards. What follows is how the scaffold wires them.

**Sessions.** The template's `restore` runs on `session_start` and
`session_tree`; rebuild your state there with
`readEntries(ctx, { type, guard })` from
[`packages/pi-session-state`](../../../packages/pi-session-state/README.md). For
state the model saw in tool results, add `restoreCard(pi, { type, build })`
after the handlers that rebuild it. To offer a service to other sessions, use
`treeService(pi, name, api)` from the same package; `tree.parent(fn)` calls the
parent's copy.

**Showing state elsewhere.** The dashboard and bb draw only `pi-surface` views
and actions, as pi-todo and pi-stash publish them: define a widget, explorer or
summary view and the actions it references (the `surface-view` skill). Keep
`<name>:<event>` bus events for lifecycle signals other extensions react to
(`subagent:completed`). Anything the session should wait for is a `pi-work`
item ([`packages/pi-work`](../../../packages/pi-work/README.md)).

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
  assertions, `ui.custom` mounting and SDK sessions are there. Import them from
  `#test-helpers` (the shared barrel).
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
npm run check
npm run test:workspace -- extensions/<name>
npm run verify:bundle
```

Then `/reload` in Pi to try it; a local checkout needs no reinstall. Commit with
`git -c commit.gpgsign=false commit`. In the PR, list the tools and commands
added and what `verify:bundle` now asserts.

## Shared libraries

Code that several extensions import goes in `packages/<name>/` instead: a
workspace with no `pi` manifest entry, so Pi never loads it as an extension.
Add it to `workspaces`, expose its source through `exports`, and add the alias
to consuming workspaces' `imports` maps. Runtime packages also need a root
`file:` dependency so Pi's Git installer creates their links. Keep test-only
packages out of root runtime dependencies. CI re-tests every workspace when a
package changes. See `packages/pi-session-state/`. A package never depends on or
imports an extension; `npm run verify:bundle` checks this. The scaffold script
does not cover packages.

## Changing the templates

`templates/` holds the files the script renders; `{{name}}`, `{{description}}`,
`{{factory}}`, `{{imports}}`, `{{registrations}}`, `{{registrationTests}}` and
`{{surface}}` are filled in, and `templates/snippets/` holds the per-tool and
per-command blocks. An unknown `{{variable}}` stops the script. After changing a
template, scaffold a throwaway extension and run step 5 on it.
