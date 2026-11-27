# Repository instructions

A bundle of Pi extensions. Pi loads the TypeScript source straight from this
checkout: there is no build step and nothing is published.

| Path                 | What lives there                                                                   |
| -------------------- | ---------------------------------------------------------------------------------- |
| `extensions/<name>/` | One Pi extension per npm workspace, registered in the root `pi.extensions`         |
| `packages/<name>/`   | Shared libraries (pi-surface, pi-ui, pi-work, …); Pi never loads them on their own |
| `skills/`            | Skills shipped in the bundle                                                       |
| `bb-plugin/`         | The bb plugin for pi-bb: its own package and toolchain, not a workspace            |
| `test/`              | Bundle scenario tests: behaviour that exists only when extensions run together     |
| `.agents/skills/`    | Skills for working on this repository (also `.claude/skills/`); not in the bundle  |

`CONTRIBUTING.md` has the layout, import aliases, tests and CI in full; the
root `README.md` has the diagrams of how the extensions fit together.

## Before you commit

```bash
npm run check                         # format, lint, types
npm run test:workspace -- <name>      # each workspace you changed
npm run verify:bundle                 # when tools, commands or skills change
```

Node.js 24 (`.nvmrc`). In `bb-plugin/`, run its own `npm run typecheck` and
`npm test`: the root check does not cover it. New cross-extension behaviour gets
a scenario in `test/` (see `test/README.md`).

Always disable GPG signing explicitly for every commit; do not change global Git
signing settings:

```bash
git -c commit.gpgsign=false commit ...
```

Keep commit subjects descriptive: each becomes a changelog entry for every
workspace it touches.

## Pull requests

When you are asked to write or change anything in this repository (code,
tests, docs, skills, agent profiles, config), finish by opening a pull request
without asking first: run the checks above, commit, push the branch and open
the PR. Say in its description what you changed and which checks passed. A
follow-up change to work whose PR is still open goes on that PR's branch. Ask
first only when the request is a question with no change to make, or it says
not to open one.

## Formatting and linting

Oxfmt formats and Oxlint lints, with one root config each (`.oxfmtrc.json`,
`.oxlintrc.json`). Never run Prettier, ESLint, Biome or dprint, and never
install them: they rewrite files to another style and leave unrelated diffs.

```bash
npm run fix                           # oxfmt, safe oxlint fixes, oxfmt again
npx oxfmt --write <paths>             # format only these files
```

`npm run fix` is safe repository-wide: CI keeps every file formatted, so it only
changes what you touched. Run `npm install --ignore-scripts` first if
`node_modules` is missing, so the pinned versions run. A guard
(`scripts/tool-guard.mjs`) blocks the other tools from shell commands, as a
Claude Code hook (`.claude/settings.json`) and a project-local Pi extension
(`.pi/extensions/tool-guard.ts`).

## Extension runtime rules

Every subagent is a full Pi session in the same process that loads every
extension again. So, in any extension:

- Keep state in the factory's closure, never in module scope: a same-cwd child
  may share the parent's module instance. Never put a bare object on
  `globalThis`; cross-session services go through `treeService` from
  `pi-session-state` or `#session-tree`.
- Persist with `pi.appendEntry` and rebuild on `session_start` and
  `session_tree` with `readEntries`, so `/tree`, resume, reload and compaction
  work. State the model saw in tool results comes back after compaction through
  one `restoreCard`.
- Never add a message to every request from a `context` handler: it breaks
  prompt caching. Write a hidden `pi.sendMessage(…, { triggerTurn: false })`
  note when state changes instead.
- Guard UI with `ctx.hasUI`; re-read `ctx` from each event, since a captured one
  goes stale after reload. Command output goes through `userOutput` from
  `pi-foundations`, so RPC hosts such as bb see it.
- Settings are declared once with `defineSettings` (`pi-foundations`); never
  read a settings file yourself.
- Tools keep output bounded and set `annotations.readOnlyHint` when they only
  read. Anything a session waits on is a `pi-work` item, not a poll.
- What other UIs should show is a `pi-surface` view or action, defined on
  `session_start` and disposed on `session_shutdown` (the `surface-view` skill).

## Terminal UI spacing

Always buffer content away from terminal edges and panel borders: reserve at least
one space on both horizontal sides of list items and other body rows. Match the
subagent widget's inset; full-width header rules and border chrome may span the
available width. Subtract padding before layout/truncation, and render blank body
rows when the width cannot fit both padding spaces plus content. Cover narrow
widths and ANSI/wide Unicode text in rendering tests.

## bb plugin spacing

In `bb-plugin/`, match bb's own chrome: the content a slot draws inside a bb
card (stack card bodies, context row segments) uses bb's 12px inset, so icons
and text line up with bb's header. Check a layout change in real bb with the
`bb-screenshot` skill: `bb-shot.mjs --expand --check` must pass.

## READMEs

READMEs show before they explain. The root `README.md` is the welcome: what the
bundle gives you, one table row per extension, skill and library, and diagrams
of how they fit. Development material belongs in `CONTRIBUTING.md`, not there.

An extension's README opens with one or two sentences on what the user gets, a
screenshot, and an `## At a glance` list of what you see, what you type and what
the agent calls. Reference material (schemas, events, internals) follows. A
library's README opens with its interface instead: the calls to make, a short
code sample, and a diagram when data moves through it.

- Images come from `.agents/skills/tui-screenshot/scripts/docs-images.mjs`.
  When a change alters what an image shows, regenerate it.
- When imports between workspaces change, update the root README's "Who
  imports what" table and diagrams.
- No per-workspace install or development sections: commands live in
  `CONTRIBUTING.md`. Vendored READMEs lose upstream install steps, badges and
  release notes.

## Extension commands

Prefix every slash command an extension registers with the extension's name
less the `pi-` prefix: `pi-subagent` registers `/subagent:agents` and
`/subagent:settings`, `pi-git` registers `/git:prs`. An extension's main command
may be the bare name (`/stash`, `/todo`); every other command is
`<name>:<action>`. Command names are lowercase.
`npm run verify:bundle` enforces this. The only exception, `pi-system-insights`
using `/system:*`, is listed in `scripts/command-names.mjs`.

`packages/pi-work` is a library, not an extension, and registers one command of
its own, `/work:wake`, through whichever extension provides the session's root
work host. It is registered at `session_start`, so the bundle check does not see
it.

## Package boundaries

Packages never depend on or import extensions: no extension in a package's
dependencies, `imports` or `exports`, and no relative import into `extensions/`.
Extensions publish state for displays as `pi-surface` views and actions;
`bb-plugin/` and the standalone dashboard hub reach the repository only through
`pi-surface`. `npm run verify:bundle` enforces this
(`scripts/package-boundary.mjs`).

## Vendored extensions

Vendored code is ours. Upstream is recorded only so we know where the code came
from; syncing with it is not a goal. Change a vendored extension as freely as
first-party code, shaped by what is best for the code. Do not weigh, mention or
avoid changes because of upstream sync cost, divergence from upstream, or
contributing changes back.

Import with the `import-extension` skill and its script: the first commit is a
verbatim copy of upstream, verified by tree hash; integration and changes follow
in later commits. The oldest `CHANGELOG.md` entry, `## Initial import`, holds
provenance: source, directory, pinned commit, tree hash when available, version,
license, import date when known, and any pinned source changelog link. Write it
once during integration; keep license files. Do not create separate provenance,
upstream issue, sync-tracking, or upstream comparison files.

## Changelogs

A weekly workflow maintains `CHANGELOG.md` for every registered workspace under
`extensions/` and `packages/`, creating missing logs from Git history. Do not
edit changelogs in feature or fix PRs. Preserve `changelog:through` and the
complete Initial import entry, including during a full rebuild. See
[CONTRIBUTING.md](CONTRIBUTING.md#changelogs) for checkpoint and workflow details.

## Skills

Skills in `skills/` ship in the same bundle as every extension in this repository,
so their tools are always available. Refer to them directly (`todo_upsert`, `subagent_start`,
`stash_put`, `job_watch`); do not write "if a subagent tool is available". Keep
conditional wording only for tools from packages outside this repository.

Skills for working on this repository, in `.agents/skills/`:

| Skill              | Use it to                                                                 |
| ------------------ | ------------------------------------------------------------------------- |
| `new-extension`    | Scaffold and register a first-party extension, or add a shared package    |
| `import-extension` | Bring in a third-party extension as a verbatim, verifiable first commit   |
| `surface-view`     | Publish an extension's state or actions so the dashboard and bb show them |
| `tui-screenshot`   | Screenshot the TUI on a scripted model; regenerate the README images      |
| `bb-screenshot`    | Run a private bb with the plugin, screenshot it and check its insets      |
