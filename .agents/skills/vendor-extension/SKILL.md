---
name: vendor-extension
description: Copy a third-party Pi extension into this repository as editable source, record its provenance in UPSTREAM.md and every local change in CHANGELOG.md. Use when importing (vendoring) an extension from GitHub or npm into extensions/, changing a vendored extension, or syncing one with a newer upstream version.
---

# Vendor an extension

Vendored extensions live in `extensions/<name>/` as plain source: no Git
submodule, no nested `.git`, no npm runtime dependency. Every one has two
records:

- `UPSTREAM.md`: where it came from and how it was copied, nothing else. It
  changes only when the extension is imported or synced with upstream.
- `CHANGELOG.md`: every local change, newest first. Its first (oldest) entry only
  points at `UPSTREAM.md`.

Examples: `extensions/pi-job/` (small additions),
`extensions/pi-todo/` (engine kept, UI replaced),
`extensions/pi-subagent/` (heavily customised fork).

## Rules

- **Import first, change later.** The verbatim copy is its own commit. Integration
  is a second commit. Behaviour changes come after, ideally in a later PR.
- **Pin a full commit SHA**, never a branch or tag.
- **Keep the license.** Copy upstream's `LICENSE` unchanged and stop if the
  license does not allow copying and modifying (MIT, Apache-2.0, BSD are fine).
- **Record every local change in `CHANGELOG.md` in the same commit as the change.**
  Never record local changes, known gaps or plans in `UPSTREAM.md`.
- **Vendored code is ours.** `UPSTREAM.md` records provenance only; syncing
  with upstream is not a goal. Edit upstream files as freely as first-party code
  and structure changes by what is best for the code, never by future sync cost
  or divergence. Each changelog entry names the files it edits.
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

If upstream ships a `CHANGELOG.md`, it is copied verbatim here like every other
file; step 4 clears it.

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
  links `UPSTREAM.md` and `CHANGELOG.md`, a warning not to install the published
  package as well, and a line under License.

## 4. Write UPSTREAM.md and CHANGELOG.md

`UPSTREAM.md` holds only the vendoring details. Use this structure (see
`extensions/pi-job/UPSTREAM.md`):

```markdown
# Vendored <name>

<one line on what it is>, imported from [`<owner>/<repo>`](url).

|                      |                                                  |
| -------------------- | ------------------------------------------------ |
| Source               | <repo url>                                       |
| Directory            | <subdir or "repository root">                    |
| Commit               | `<full sha>` (<date>, "<subject>")               |
| Upstream version     | `<package>` <version>                            |
| Upstream tested with | Pi <x.y.z>, Node.js <x>                          |
| License              | <license>; original notice retained in `LICENSE` |
| Imported             | <date>                                           |

<Not a submodule; which entry point the bundle loads; don't install the npm package too.>

## Import

<How it was copied, what was left out and why, and whether upstream's changelog
was cleared.>

## Sync history

| Date   | Upstream commit           | Notes           |
| ------ | ------------------------- | --------------- |
| <date> | `<short sha>` (<version>) | Initial import. |
```

`CHANGELOG.md` holds every local change, newest entry first. Create it, or if
upstream shipped one, replace its whole content: upstream's history stays in the
source repository, linked at the pinned commit. The first entry is only the
pointer to `UPSTREAM.md`; the integration changes are the next entry:

```markdown
# Changelog

Local changes to this vendored copy, newest first. Where it came from is
recorded in [UPSTREAM.md](UPSTREAM.md).

## <date>: Integration (#<pr>)

- <file or area>: <what changed and why>
- Known gap: <type errors, version mismatches, UI rules not yet applied, missing
  tests>

## <date>: Vendored

Imported from upstream; see [UPSTREAM.md](UPSTREAM.md). Upstream's changelog was
cleared at import; for earlier history see the
[source changelog](<repo url>/blob/<full sha>/<subdir/>CHANGELOG.md).
```

Leave out the sentence about the source changelog when upstream had none. Add
`CHANGELOG.md` to the `files` list in `package.json` next to `UPSTREAM.md`.

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

1. Make the change where it belongs, editing upstream files as needed.
2. In the same commit, add an entry at the top of `CHANGELOG.md`
   (`## <date>: <summary> (#<pr>)`) listing each file or area and what changed,
   and naming any known gap it fixes or introduces. Do not touch `UPSTREAM.md`.

## Syncing with a newer upstream

Only when explicitly asked. Never suggest a sync or plan changes around one.

1. Clone upstream and diff the pinned SHA against the new one:
   `git -C <scratch>/<repo> diff <old sha> <new sha> -- . ':!.github'`.
2. Apply that diff to `extensions/<name>/`, except upstream's `CHANGELOG.md`,
   which stays local. Resolve conflicts against the local changes listed in
   `CHANGELOG.md`.
3. In `UPSTREAM.md`, update the Commit, Upstream version, and Upstream tested
   with rows and add a **Sync history** row. In `CHANGELOG.md`, add an entry for
   the sync that links the source changelog between the two commits and lists
   any local change the sync reworked or made unnecessary.
4. Run the checks in step 5 and open a PR titled
   `chore(<name>): sync upstream to <short sha>`.
