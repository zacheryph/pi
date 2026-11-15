# Changelog

Changes recorded automatically from Git history, newest first.

<!-- changelog:through aa756f8a1345f53efab119ea3193ee7fe53f79ec -->

- 2026-11-15: docs: consolidate import provenance in initial changelog entries ([#177](https://github.com/zacheryph/pi/pull/177))
- 2026-11-13: feat\(pi-job\): /job answers without a terminal ([#171](https://github.com/zacheryph/pi/pull/171))
- 2026-11-12: feat\(pi-git\): watch a pull request as a work item that wakes the session ([#154](https://github.com/zacheryph/pi/pull/154))
- 2026-11-12: refactor: centralize workspace configs and development commands ([#153](https://github.com/zacheryph/pi/pull/153))
- 2026-11-12: refactor: standardize workspace aliases and shared test helpers ([#149](https://github.com/zacheryph/pi/pull/149))
- 2026-11-12: feat\(pi-work\): answer work that reported back while Pi was busy ([#150](https://github.com/zacheryph/pi/pull/150))
- 2026-11-12: refactor\(pi-foundations\): consolidate plain-data helpers ([#147](https://github.com/zacheryph/pi/pull/147))
- 2026-11-11: refactor\(pi-job\): drop the completion dedupe for older transcripts ([#141](https://github.com/zacheryph/pi/pull/141))
- 2026-11-10: test\(pi-job\): wait for the job output in the job\_read test ([#122](https://github.com/zacheryph/pi/pull/122))
- 2026-11-10: Keep idle agents across parent reload and restart ([#121](https://github.com/zacheryph/pi/pull/121))
- 2026-11-10: Close a work item only once its message is in the transcript ([#121](https://github.com/zacheryph/pi/pull/121))
- 2026-11-09: Port pi-job to the work contract ([#111](https://github.com/zacheryph/pi/pull/111))
- 2026-11-09: Define the work contract and the root host ([#110](https://github.com/zacheryph/pi/pull/110))
- 2026-11-09: Deliver pi-job completions through Pi's run boundaries ([#108](https://github.com/zacheryph/pi/pull/108))
- 2026-11-09: chore: update Pi to 1.5.0 ([c78186c](https://github.com/zacheryph/pi/commit/c78186c20776d4dbb00893cf3118132c3b874197))
- 2026-11-08: test: add fauxSession and build SDK tests on it ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test: add shared wait helpers and replace inline timer promises ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test: add pi-test-helpers with tempDir and use it for test temp directories ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test\(pi-job\): wait for PID contents at every PID read ([#103](https://github.com/zacheryph/pi/pull/103))
- 2026-11-08: test\(pi-job\): pass under root and a non-reaping init ([#103](https://github.com/zacheryph/pi/pull/103))
- 2026-11-05: test\(pi-job\): wait for PID contents before shutdown assertions ([#90](https://github.com/zacheryph/pi/pull/90))
- 2026-11-02: docs\(vendor\): keep UPSTREAM.md to vendoring details and log local changes in CHANGELOG.md ([#65](https://github.com/zacheryph/pi/pull/65))
- 2026-11-01: refactor\(pi-job\): rename pi-jobs to pi-job and scope its identifiers ([#58](https://github.com/zacheryph/pi/pull/58))
- 2026-10-31: chore: adopt Oxc and TypeScript 7 across all workspaces ([#42](https://github.com/zacheryph/pi/pull/42))
- 2026-10-30: feat\(pi-jobs\): tool checks for job\_watch \(\#9\) ([#26](https://github.com/zacheryph/pi/pull/26))
- 2026-10-29: chore: share stricter compiler settings and drop redundant vitest aliases ([#17](https://github.com/zacheryph/pi/pull/17))
- 2026-10-29: chore\(deps\): align dev dependencies with Pi and Node 24, upgrade Vitest 5 ([#15](https://github.com/zacheryph/pi/pull/15))
- 2026-10-29: feat\(pi-jobs\): vendor woksin/pi-jobs, pin Pi 1.4.0, and add a vendor-extension skill ([#12](https://github.com/zacheryph/pi/pull/12))

## Initial import

- Source: [`woksin/pi-jobs`](https://github.com/woksin/pi-jobs), repository root.
- Pinned revision: `a1c27af538b059815beddbb4c4f2c98cfe1eb3e9`
  (2026-10-23, “docs: refresh README”).
- Version: `@woksin/pi-jobs` 0.3.1; tested with Pi 1.3.0 and Node.js 22.19+ at import.
- Imported: 2026-10-29.
- License: MIT; original notice retained in [LICENSE](LICENSE).

Copied every tracked file except `.github/` from a shallow checkout with
`git ls-files | tar`. The first import-branch commit was the source copy alone;
`diff -r` against that checkout showed no differences. The bundle loads
`src/extension.ts` as editable source, not a submodule or npm runtime dependency.
Do not also install the published `@woksin/pi-jobs` package.

Earlier upstream history is in the
[pinned source changelog](https://github.com/woksin/pi-jobs/blob/a1c27af538b059815beddbb4c4f2c98cfe1eb3e9/CHANGELOG.md).
