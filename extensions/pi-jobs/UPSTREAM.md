# Vendored pi-jobs

Background shell jobs and watches for Pi, imported from
[`woksin/pi-jobs`](https://github.com/woksin/pi-jobs).

| | |
| --- | --- |
| Source | https://github.com/woksin/pi-jobs |
| Directory | repository root |
| Commit | `a1c27af538b059815beddbb4c4f2c98cfe1eb3e9` (2026-10-23, "docs: refresh README") |
| Upstream version | `@woksin/pi-jobs` 0.3.1 |
| Upstream tested with | Pi 1.3.0, Node.js 22.19+ |
| License | MIT; original notice retained in `LICENSE` |
| Imported | 2026-10-29 |

This is an editable source copy, not a Git submodule or npm runtime dependency.
The root bundle exposes `src/extension.ts`. Install the root bundle; do not also
install `npm:@woksin/pi-jobs`.

## Import

Shallow-cloned upstream outside this repository and copied every tracked file
except `.github/` (upstream CI and npm publish workflows) with
`git ls-files | tar`. The first commit on the import branch is that copy alone;
`diff -r` against the clone showed no differences.

Still byte-for-byte with upstream: `e2e/`, `README.md`, `CHANGELOG.md`,
`UPSTREAM-ISSUES.md` (upstream's own notes on Pi-side limitations, unrelated to
this file), `LICENSE`, `.gitignore`, and every file under `src/` and `test/`
except the five listed under **Typecheck** below.

## Local changes

### Integration (import PR)

Manifest only; this step changed no file under `src/`, `test/`, or `e2e/`.

- `package.json`: marked `private`, removed `publishConfig`.
- `package.json`: added a `check` script, since CI runs `npm run check` for each
  changed workspace and upstream has none (now a typecheck; see below).
- `package.json`: added `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`
  dev dependencies, matching the bundle's Pi pin (now 1.4.0), so upstream's
  `test/runtime.ts` resolves a local runtime instead of a user installation.
- Root `package.json`: added the workspace and the `pi.extensions` entry.
- `scripts/verify-bundle.mjs`: asserts the `job_*` tools and `/jobs` command.

### Typecheck

Upstream never typechecks; it relies on its tests. Added `tsconfig.json`
(extending the bundle's strict `tsconfig.base.json`) and made `check` run
`tsc --noEmit`, plus `node --check` for the plain-JavaScript `e2e/*.mjs`. Added
`typescript` and `@types/node` dev dependencies like the other workspaces.

Five typing fixes; runtime behaviour is unchanged:

- `src/extension.ts`: the `message_end` handler takes `unknown` and narrows inside,
  like upstream's other handlers. Its narrower parameter type matched no `pi.on`
  overload.
- `src/ownership.ts` (`takeReloadOwner`): `source?.delete(…)`. `source` is always
  defined there because `owner` came from it, but TypeScript cannot infer that.
- `src/supervisor.ts`: casts `child.stdio` through `unknown` to the four streams it
  uses. Node types it as a five-entry tuple.
- `test/delivery.test.ts`: reads the private `Delivery.disposed` through a cast.
- `test/extension.test.ts`: `assert.throws` gets a validator that accepts any
  thrown value, instead of `undefined`, which Node's types reject when a message
  follows.

## Known gaps

- **UI.** pi-jobs registers no widgets or custom tool renderers, so the
  `AGENTS.md` spacing rules do not apply yet. Recheck when adding UI.
- **Persistence.** Jobs survive `/reload` in the same process, not a Pi restart.

## Planned changes

- [#9](https://github.com/zacheryph/pi/issues/9): tool and codemode checks for
  `job_watch`.

## Sync history

| Date | Upstream commit | Notes |
| --- | --- | --- |
| 2026-10-29 | `a1c27af` (0.3.1) | Initial import. |
