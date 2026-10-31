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

The Oxc migration formats source, tests, scripts, and Markdown with the bundle's
shared configuration. These files no longer claim byte-for-byte parity with
upstream; the import commit remains the reference for comparing local changes.
The original license and import history are retained.

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
`typescript` and `@types/node` dev dependencies like the other workspaces
(`@types/node` follows the bundle's Node.js 24 floor).

The shared base's unused-local checks now apply here too. The Oxc cleanup
removes the unused test binding, uses Node's actual asynchronous cleanup-hook
type, and explicitly discards test-registration promises (the Node runner tracks
the tests). Test message fixtures describe both string and text-block content.
Shared tools and development dependencies live at the repository root.

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

### Pi `executeTool` contract (#9 spike)

- `test/pi-execute-tool.contract.test.ts` (new, local): pins the Pi behaviour
  that `job_watch` tool checks will rely on. Calls through a tool's kept
  `ExtensionToolContext` after that call returned:
  - work while idle, during another streaming run, and after compaction;
  - leave no nested-call record on any saved message;
  - run `tool_call` hooks, which can block them; ids are `<caller id>/<n>`;
  - fail without running after `/tree` to a point with no assistant message;
  - throw a stale-context error after reload.

  `codemode` is `model-only`, so `executeTool` cannot run it.

### Tool checks (#9)

`job_watch` accepts `toolCheck` instead of `check`: one Pi tool call per interval
through the kept `ctx.executeTool`, with an optional `match` on the result. Usage,
allowlist, and lifecycle are in [TOOL-CHECKS.md](TOOL-CHECKS.md). Codemode
script checks are not supported (see above).

New files, so upstream syncs do not touch them:

- `src/probe.ts`: runs an async check with the contract `runCheck` expects from a
  `SupervisedRun` (one outcome, `terminate()` wins over a late result).
- `src/toolcheck.ts`: spec validation, the allowlist, `match`, canonical JSON, and
  the consecutive-error limit.
- `test/toolcheck.test.ts` (unit) and `test/toolcheck-session.test.ts` (real
  `AgentSession`, faux provider).
- `TOOL-CHECKS.md`.

Edits to upstream files, kept small:

- `src/watch.ts`: `CheckResult.inconclusive`; `evaluateWatch` treats it like a
  timed-out check (no match, no baseline).
- `src/jobs.ts`: `WatchOptions.probe`; `runCheck` starts the probe instead of a
  shell run when one is given, logs `inconclusive` checks, and settles the watch
  `failed` on a probe's final error. `Job.run` is typed as the shared `CheckRun`
  interface; `envLimit` is exported for reuse.
- `src/extension.ts`: `toolCheck` in the `job_watch` schema (`check` is no
  longer required by the schema; exactly one of the two is enforced in
  `execute`) and the wiring to `ctx.executeTool`, `pi.getAllTools()`,
  `PI_JOBS_WATCH_TOOLS`, and `PI_JOBS_MAX_CHECK_ERRORS`.
- `src/format.ts`: "last check inconclusive" in notifications.

## Known gaps

- **UI.** pi-jobs registers no widgets or custom tool renderers, so the
  `AGENTS.md` spacing rules do not apply yet. Recheck when adding UI.
- **Persistence.** Jobs survive `/reload` in the same process, not a Pi restart.

## Planned changes

- Codemode script checks for `job_watch` (#9), if Pi gains a way for extensions
  to run codemode scripts.

## Sync history

| Date       | Upstream commit   | Notes           |
| ---------- | ----------------- | --------------- |
| 2026-10-29 | `a1c27af` (0.3.1) | Initial import. |
