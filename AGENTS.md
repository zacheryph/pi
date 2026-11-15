# Repository instructions

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

The weekly workflow maintains later entries; do not edit them in feature or fix
PRs. Keep commit subjects descriptive: each becomes an entry with its UTC commit
date and introducing PR link (or commit link). Preserve `changelog:through` and
the complete Initial import entry, including during a full rebuild.

## Changelogs

The same weekly workflow maintains `CHANGELOG.md` for every registered workspace
under `extensions/` and `packages/`, creating missing logs from Git history.
Logs without a checkpoint are rebuilt from full history, following directory
renames and retaining the complete Initial import entry from the previous log.
See the root README's Changelogs section for checkpoint and workflow details.

## Git commits

Always disable GPG signing explicitly for every commit:

```bash
git -c commit.gpgsign=false commit ...
```

Do not change global Git signing settings.

## Skills

Skills in `skills/` ship in the same bundle as every extension in this repository,
so their tools are always available. Refer to them directly (`todo_upsert`, `subagent_start`,
`stash_put`, `job_watch`); do not write "if a subagent tool is available". Keep
conditional wording only for tools from packages outside this repository.
