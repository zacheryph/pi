---
name: vendor-extension
description: Import a third-party Pi extension into extensions/ as editable source, with a first commit that is a verbatim, verifiable copy of the upstream commit. Use when vendoring an extension from GitHub or npm into this repository.
---

# Vendor an extension

Vendoring copies a third-party extension into `extensions/<name>/` as plain
source we own from then on: no submodule, no nested `.git`, no npm runtime
dependency. The point of this skill is a clean history: the **first commit is
upstream's tree exactly as it was at one commit**, so anyone can prove it
matches the source. Everything we change comes in later commits.

Upstream is recorded only as provenance. Once imported, the code is ours and is
changed like first-party code (see `AGENTS.md`).

## 1. Pin the source

Clone outside the repository, into your scratchpad or a temp directory, and pick
a full commit SHA (never a branch or tag):

```bash
git clone https://github.com/<owner>/<repo>.git <scratch>/<repo>
git -C <scratch>/<repo> checkout <sha>   # or stay on HEAD and use its SHA
git -C <scratch>/<repo> log -1 --format='%H %cd %s'
```

Check the license allows copying and modifying (MIT, Apache-2.0 and BSD do).
Stop if it does not.

## 2. Verbatim import commit

Copy exactly the files Git tracks at that commit. Nothing added, nothing left
out, nothing edited, file modes kept:

```bash
mkdir extensions/<name>
(cd <scratch>/<repo> && git ls-files -z | tar --null -cf - -T -) \
  | tar -xf - -C extensions/<name>
git add -f extensions/<name>
```

For a monorepo package, use `git ls-files -z -- <subdir>` and add
`--strip-components=<depth of subdir>` to the extracting `tar`. `-f` matters:
without it, this repository's or upstream's `.gitignore` can silently drop
tracked files such as a committed `dist/`.

Verify before committing. The staged directory's tree hash must equal
upstream's:

```bash
git write-tree --prefix=extensions/<name>/
git -C <scratch>/<repo> rev-parse '<sha>^{tree}'      # or '<sha>:<subdir>'
```

Different hashes mean a missing, extra or changed file (or mode). Find it with
`diff -r` and fix the copy, never the expectation. Commit only that directory:

```
chore(<name>): import <owner>/<repo>@<short sha> verbatim

Unmodified copy of https://github.com/<owner>/<repo> at commit <full sha>
(<package> <version>, <license>). Tree <tree hash> equals upstream's.
Not yet registered in the bundle.
```

Commit with `git -c commit.gpgsign=false commit …`. Do not run the imported code
yet: its tests and scripts are third-party code, so read them first.

## 3. Integration commit

The second commit makes it part of the bundle. Anything that has to go
(upstream's `.github/`, a nested `AGENTS.md`, publishing config) is removed
here, not left out of the import.

- `extensions/<name>/package.json`: `"private": true`, no `publishConfig`, and
  `check` and `test` scripts (CI runs both for every changed workspace, with no
  `--if-present`). Prefer `tsc --noEmit` with a `tsconfig.json` extending
  `../../tsconfig.base.json`, and fix type errors in the code. Keep Pi packages
  as `"*"` peer dependencies and pin dev dependencies to the Pi version the
  other workspaces use. Replace monorepo-only settings such as `catalog:`
  versions.
- Root `package.json`: add the workspace and its entry point to `pi.extensions`;
  runtime dependencies go in the root `dependencies`. Run
  `npm install --ignore-scripts` so the lockfile matches (CI uses `npm ci`).
- `scripts/verify-bundle.mjs`: assert its tools and commands.
- Root `README.md`: layout tree entry and an `### <name>` section linking
  `UPSTREAM.md` and `CHANGELOG.md`, with a warning not to install the published
  package too, and a line under License.
- `UPSTREAM.md` and `CHANGELOG.md`, below.

Then run `npm run check --workspace=extensions/<name>`,
`npm run test --workspace=extensions/<name>` and `npm run verify:bundle`. If you
can't run the imported code, say so and rely on CI; never call it verified
without seeing it pass.

## UPSTREAM.md and CHANGELOG.md

`UPSTREAM.md` is provenance only and is not edited after import:

```markdown
# Vendored <name>

<one line on what it is>, imported from [`<owner>/<repo>`](url).

|           |                                                   |
| --------- | ------------------------------------------------- |
| Source    | <repo url>                                        |
| Directory | <subdir or "repository root">                     |
| Commit    | `<full sha>` (<date>, "<subject>")                |
| Tree      | `<tree hash>`, equal to the import commit's       |
| Version   | `<package>` <version>                             |
| License   | <license>; original notice retained in `LICENSE`  |
| Imported  | <date>, commit `<short sha of the import commit>` |
```

`CHANGELOG.md` holds every local change, newest first, each added in the same
commit as the change. If upstream shipped one, replace its content: its history
stays upstream. The oldest entry only points at `UPSTREAM.md`; the integration
is the next one:

```markdown
# Changelog

Local changes to this vendored copy, newest first. Where it came from is
recorded in [UPSTREAM.md](UPSTREAM.md).

## <date>: Integration (#<pr>)

- <file or area>: <what changed and why>

## <date>: Vendored

Imported from upstream; see [UPSTREAM.md](UPSTREAM.md). For earlier history see
the [source changelog](<repo url>/blob/<full sha>/<subdir/>CHANGELOG.md).
```

Leave out the source-changelog sentence when upstream had none.

## The PR

Give the source, SHA and tree hash, say the first commit is the verbatim copy
and how to check it, and list the integration changes. Behaviour changes go in
later commits, ideally a later PR.
