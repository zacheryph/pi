# Repository instructions

## Terminal UI spacing

Always buffer content away from terminal edges and panel borders: reserve at least
one space on both horizontal sides of list items and other body rows. Match the
subagent widget's inset; full-width header rules and border chrome may span the
available width. Subtract padding before layout/truncation, and render blank body
rows when the width cannot fit both padding spaces plus content. Cover narrow
widths and ANSI/wide Unicode text in rendering tests.

## Vendored extensions

Vendored code is ours. Upstream is recorded only so we know where the code came
from; syncing with it is not a goal. Change a vendored extension as freely as
first-party code, shaped by what is best for the code. Do not weigh, mention or
avoid changes because of upstream sync cost, divergence from upstream, or
contributing changes back.

Each vendored extension keeps two records (see the `vendor-extension` skill):

- `UPSTREAM.md` holds only the vendoring details: source, pinned commit, version,
  license, how it was copied, and the sync history. Change it only when importing
  or syncing with upstream.
- `CHANGELOG.md` holds every local change, newest first, added in the same commit
  as the change. Its first (oldest) entry only points at `UPSTREAM.md`. If
  upstream shipped a changelog, its content is cleared at import and that entry
  links the source changelog at the pinned commit instead.

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
