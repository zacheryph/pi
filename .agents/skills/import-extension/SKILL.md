---
name: import-extension
description: Import a third-party Pi extension into extensions/ as editable source we own. A script makes the first commit a verbatim copy of one upstream commit, verified by Git tree hash, then prepares the integration changes for review. Use when bringing an extension from GitHub, npm's source repository or a local clone into this repository.
---

# Import an extension

An imported extension lives in `extensions/<name>/` as plain source we own from
then on: no submodule, no nested `.git`, no npm runtime dependency. Upstream is
recorded only as provenance (see `AGENTS.md`).

The point is a clean history:

1. **Import commit:** upstream's tree exactly as it is at one commit. Nothing
   added, removed or edited. Its tree hash equals upstream's, so anyone can
   check it.
2. **Integration commit:** everything that makes it part of the bundle.
3. **Later commits:** behaviour changes, each with a `CHANGELOG.md` entry.

## 1. Run the script

From the repository root, with nothing staged:

```bash
node .agents/skills/import-extension/scripts/import.mjs pi-<topic> \
  --source https://github.com/<owner>/<repo> --ref <full sha>
```

| Option            | Effect                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `--source`        | Git URL or local repository. Required.                                                         |
| `--ref`           | Commit, tag or branch to import; recorded as a full SHA. Default: the default branch's `HEAD`. |
| `--subdir`        | The package's directory in a monorepo. Its tree is what gets compared.                         |
| `--after`         | Register after that extension in `pi.extensions` (load order). Default: last.                  |
| `--allow-license` | Accept a license other than MIT, ISC, Apache-2.0, BSD or 0BSD, after you read it.              |
| `--trailer`       | Repeatable `"Key: value"` line appended to the import commit, such as a `Co-Authored-By` line. |
| `--no-install`    | Skip `npm install --ignore-scripts`; the lockfile is then stale until you run it.              |

It checks everything before writing: name format, an existing directory or
workspace, staged changes, a license file and an accepted license, submodules,
and a `pi.extensions` entry in upstream's `package.json`. Then it:

- writes each upstream blob byte for byte with its mode (symlinks and executable
  bits included), stages it with `git add -f` so no `.gitignore` drops a tracked
  file, and **commits only if `git write-tree --prefix=extensions/<name>/` equals
  upstream's tree hash**;
- leaves these integration changes uncommitted: removes upstream's `.github/`
  and lockfiles, copies a monorepo's root license into the package, marks
  `package.json` private without `publishConfig`, writes `UPSTREAM.md` and
  `CHANGELOG.md`, registers the workspace and its `pi.extensions` entries in the
  root `package.json`, and runs `npm install --ignore-scripts`;
- prints what is left to do.

Do not run the imported code yet. Its tests and scripts are third-party code, so
read them first.

## 2. Finish the integration commit

Work through the script's list. It usually includes:

- Upstream files it flagged for review (a nested `AGENTS.md`, `.pi/`, and so
  on): keep or remove each.
- The root TypeScript and Vitest projects include registered workspaces
  automatically. Keep development scripts and configs at the root; migrate any
  necessary upstream test setup to the shared tooling, and fix type errors in
  the code.
- Dependencies: Pi packages stay `"*"` peer dependencies; drop dev tools the
  root provides; move runtime dependencies to the root `dependencies` (a Git
  install of the bundle installs only those); replace `catalog:` and
  `workspace:` versions.
- An entry point that is build output: point the root `pi.extensions` entry at
  the TypeScript source, since the bundle has no build step.
- `scripts/verify-bundle.mjs`: assert its tools and commands.
- Root `README.md`: the layout tree, an `### <name>` section linking `UPSTREAM.md`
  and `CHANGELOG.md` with a warning not to install the published package too,
  and a line under License.
- Every other change you make, as a bullet in the `CHANGELOG.md` integration
  entry.

Then run `npm run check`, `npm run test:workspace -- extensions/<name>`
and `npm run verify:bundle`, and commit with `git -c commit.gpgsign=false
commit`. If you can't run the imported code, say so and rely on CI; never call it
verified without seeing it pass.

## The records

- `UPSTREAM.md` is provenance only (source, directory, commit, tree hash,
  version, license, import date and commit). The script writes it; it is not
  edited after import.
- `CHANGELOG.md` holds every local change, newest first, each added in the same
  commit as the change. Upstream's changelog is replaced at import; the oldest
  entry points at `UPSTREAM.md` and links the source changelog at the pinned
  commit when there was one.

## The PR

Give the source, SHA and tree hash, say the first commit is the verbatim copy
and that `git rev-parse <import commit>:extensions/<name>` reproduces the tree
hash, and list the integration changes. Behaviour changes go in later commits,
ideally a later PR.
