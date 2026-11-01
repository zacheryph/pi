# Vendored pi-jobs

Background shell jobs and watches for Pi, imported from
[`woksin/pi-jobs`](https://github.com/woksin/pi-jobs).

|                      |                                                                                 |
| -------------------- | ------------------------------------------------------------------------------- |
| Source               | https://github.com/woksin/pi-jobs                                               |
| Directory            | repository root                                                                 |
| Commit               | `a1c27af538b059815beddbb4c4f2c98cfe1eb3e9` (2026-10-23, "docs: refresh README") |
| Upstream version     | `@woksin/pi-jobs` 0.3.1                                                         |
| Upstream tested with | Pi 1.3.0, Node.js 22.19+                                                        |
| License              | MIT; original notice retained in `LICENSE`                                      |
| Imported             | 2026-10-29                                                                      |

This is an editable source copy, not a Git submodule or npm runtime dependency.
The root bundle exposes `src/extension.ts`. Install the root bundle; do not also
install `npm:@woksin/pi-jobs`.

## Import

Shallow-cloned upstream outside this repository and copied every tracked file
except `.github/` (upstream CI and npm publish workflows) with
`git ls-files | tar`. The first commit on the import branch is that copy alone;
`diff -r` against the clone showed no differences.

Upstream's `CHANGELOG.md` was cleared; its history up to the import is in the
[source changelog](https://github.com/woksin/pi-jobs/blob/a1c27af538b059815beddbb4c4f2c98cfe1eb3e9/CHANGELOG.md).
Local changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## Sync history

| Date       | Upstream commit   | Notes           |
| ---------- | ----------------- | --------------- |
| 2026-10-29 | `a1c27af` (0.3.1) | Initial import. |
