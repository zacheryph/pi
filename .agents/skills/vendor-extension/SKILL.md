---
name: vendor-extension
description: Copy a third-party Pi extension into this repository as editable source and track its provenance and local changes in UPSTREAM.md. Use when importing (vendoring) an extension from GitHub or npm into extensions/, changing a vendored extension, or syncing one with a newer upstream version.
---

# Vendor an extension

Vendored extensions live in `extensions/<name>/` as plain source: no Git
submodule, no nested `.git`, no npm runtime dependency. Every one has an
`UPSTREAM.md` that records where it came from and every local change. Examples:
`extensions/pi-jobs/UPSTREAM.md` (unchanged import),
`extensions/pi-todo/UPSTREAM.md` (engine kept, UI replaced),
`extensions/pi-subagents/UPSTREAM.md` (heavily customised fork).

## Rules

- **Import first, change later.** The verbatim copy is its own commit. Integration
  is a second commit. Behaviour changes come after, ideally in a later PR.
- **Pin a full commit SHA**, never a branch or tag.
- **Keep the license.** Copy upstream's `LICENSE` unchanged and stop if the
  license does not allow copying and modifying (MIT, Apache-2.0, BSD are fine).
- **Record every local change in `UPSTREAM.md` in the same commit as the change.**
- **Prefer sidecar modules over edits.** Put new behaviour in new files and keep
  upstream files byte-for-byte where possible, so syncs stay cheap. Name the
  byte-for-byte files in `UPSTREAM.md`.
- Commit with `git -c commit.gpgsign=false commit …`. Never change global Git config.
- Anything the extension renders follows the terminal UI spacing rules in `AGENTS.md`.

## 1. Pin the source

Clone outside the repository, into your scratchpad or a temp directory:

```bash
git clone --depth 1 https://github.com/<owner>/<repo>.git <scratch>/<repo>
git -C <scratch>/<repo> log -1 --format='%H %cd %s'
```

Record the SHA, the date, the package name and version from its `package.json`,
the subdirectory if it is a monorepo, the license, and the Pi version upstream
says it is tested with.

## 2. Verbatim import commit

Copy the tracked files, leaving out upstream's `.github/` (CI and publishing):

```bash
mkdir extensions/<name>
(cd <scratch>/<repo> && git ls-files | grep -v '^\.github/' | tar -cf - -T -) \
  | tar -xf - -C extensions/<name>
diff -r --exclude=.git --exclude=.github <scratch>/<repo> extensions/<name> && echo IDENTICAL
```

For a monorepo, run `git ls-files <subdir>` and strip the prefix (`tar
--strip-components`). Leave out media and contributor-only config (`.pi/`,
`AGENTS.md`) only when they would affect this repository, and note it.

Commit only that directory:

```
chore(<name>): import <owner>/<repo>@<short sha> verbatim

Unmodified copy of https://github.com/<owner>/<repo> at commit <full sha>
(<package> <version>, <license>). Every tracked upstream file except .github/.
Not yet registered in the bundle.
```

Do not run the imported code yet. Read it first: imported tests and scripts
are third-party code.

## 3. Integration commit

Keep changes to the manifest and the repository wiring.

In `extensions/<name>/package.json`:

- Add `"private": true` and remove `publishConfig`.
- Make sure there are `check` and `test` scripts. CI runs
  `npm run check --workspace=<dir>` and `npm run test --workspace=<dir>` for
  every changed workspace, with no `--if-present`.
  - Prefer `tsc --noEmit` with a `tsconfig.json` extending
    `../../tsconfig.base.json` (see `extensions/pi-todo/tsconfig.json`).
  - If upstream code does not pass the strict typecheck and fixing it would edit
    upstream source, use a syntax gate instead and list the type errors under
    Known gaps:
    `for f in src/*.ts test/*.ts; do node --check "$f" || exit 1; done`
- Keep Pi packages as `"*"` peer dependencies. Pin dev dependencies to the Pi
  version the other workspaces use (currently `1.4.0`).
- Replace monorepo-only settings such as `catalog:` versions or shared lint
  configs with plain equivalents, and note each one.

At the repository root:

- `package.json`: add `extensions/<name>` to `workspaces` and its entry point to
  `pi.extensions`. Runtime dependencies go in the root `dependencies` so Git
  installs get them.
- Run `npm install --ignore-scripts` to update `package-lock.json`. CI uses
  `npm ci`, so a stale lockfile fails every job.
- `scripts/verify-bundle.mjs`: assert the extension's tools and commands. The
  script already fails on duplicate tool, command, or flag names.
- `README.md`: add the extension to the layout tree, an `### <name>` section that
  links `UPSTREAM.md`, a warning not to install the published package as well,
  and a line under License.

## 4. Write UPSTREAM.md

Use this structure (see `extensions/pi-jobs/UPSTREAM.md`):

```markdown
# Vendored <name>

<one line on what it is>, imported from [`<owner>/<repo>`](<url>).

| | |
| --- | --- |
| Source | <repo url> |
| Directory | <subdir or "repository root"> |
| Commit | `<full sha>` (<date>, "<subject>") |
| Upstream version | `<package>` <version> |
| Upstream tested with | Pi <x.y.z>, Node.js <x> |
| License | <license>; original notice retained in `LICENSE` |
| Imported | <date> |

<Not a submodule; which entry point the bundle loads; don't install the npm package too.>

## Import
<How it was copied, what was left out and why, which files are byte-for-byte.>

## Local changes
### <change group, e.g. Integration (import PR), Personal widget>
- <file or area>: <what changed and why>

## Known gaps
<Type errors, version mismatches, UI rules not yet applied, missing tests.>

## Planned changes
<Linked issues.>

## Sync history
| Date | Upstream commit | Notes |
| --- | --- | --- |
| <date> | `<short sha>` (<version>) | Initial import. |
```

## 5. Verify and open the PR

```bash
npm run check --workspace=extensions/<name>
npm run test --workspace=extensions/<name>
npm run verify:bundle
```

If you are not allowed to run the imported code locally, say so in the PR and
rely on CI. Never mark it verified without seeing it pass. In the PR
description, give the source and SHA, say that the first commit is the
untouched copy, and list each integration change.

## Changing a vendored extension later

1. Put new behaviour in sidecar modules when you can; edit upstream files only
   when necessary.
2. In the same commit, add the change under **Local changes**, update the
   byte-for-byte list if a file left it, and remove any **Known gaps** it fixes.

## Syncing with a newer upstream

1. Clone upstream and diff the pinned SHA against the new one:
   `git -C <scratch>/<repo> diff <old sha> <new sha> -- . ':!.github'`.
2. Apply that diff to `extensions/<name>/`. Resolve conflicts against the local
   changes listed in `UPSTREAM.md`.
3. Update the Commit, Upstream version, and Upstream tested with rows, add a
   **Sync history** row, and update any local-change notes the sync affected.
4. Run the checks in step 5 and open a PR titled
   `chore(<name>): sync upstream to <short sha>`.
