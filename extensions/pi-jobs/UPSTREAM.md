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

Kept as upstream wrote them: `src/`, `test/`, `e2e/`, `README.md`, `CHANGELOG.md`,
`UPSTREAM-ISSUES.md` (upstream's own notes on Pi-side limitations, unrelated to
this file), `LICENSE`, `.gitignore`.

## Local changes

### Integration (import PR)

Manifest only. No file under `src/`, `test/`, or `e2e/` differs from upstream.

- `package.json`: marked `private`, removed `publishConfig`.
- `package.json`: added a `check` script that runs `node --check` on every source,
  test, and e2e file. CI runs `npm run check` for each changed workspace and
  upstream has none. This is a syntax gate through Node's type stripping, not a
  typecheck.
- `package.json`: added `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`
  `1.1.0` dev dependencies, matching the bundle's Pi pin, so upstream's
  `test/runtime.ts` resolves a local runtime instead of a user installation.
- Root `package.json`: added the workspace and the `pi.extensions` entry.
- `scripts/verify-bundle.mjs`: asserts the `job_*` tools and `/jobs` command.

## Known gaps

- **No strict typecheck.** `tsc --noEmit` with the bundle's strict settings and
  Pi 1.1.0 types reports five errors in upstream code. Upstream never typechecks;
  it relies on its tests. Fixing them means editing upstream source, so it waits
  for the first behavioural change. The errors:
  - `src/extension.ts`: the `message_end` handler's parameter type is narrower
    than `MessageEndEvent`, so no `pi.on` overload matches. The event exists in
    Pi 1.1.0; this is typing only.
  - `src/ownership.ts`: `source` possibly `undefined`.
  - `src/supervisor.ts`: casting `child.stdio` (five entries) to a four-entry tuple.
  - `test/delivery.test.ts`: reads the private `Delivery.disposed`.
  - `test/extension.test.ts`: passes `undefined` as an `assert` predicate.
- **Pi version.** Upstream is tested with Pi 1.3.0; the bundle pins 1.1.0 for
  development. CI runs the upstream tests against 1.1.0.
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
