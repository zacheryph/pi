# Changelog

Local changes to this vendored copy, newest first. Where it came from is
recorded in [UPSTREAM.md](UPSTREAM.md).

## 2026-11-08: Tests under root and non-reaping init

- The test helper `alive()` counts a zombie as dead. Killed orphans are
  reparented to PID 1, and some container inits never reap them, so
  `kill(pid, 0)` kept succeeding and the host-exit escalation test timed out.
- Skip the unopenable-log-file test as root, which ignores directory
  permissions, so the expected EACCES never happens.
- Read every test PID with `waitForPid`. The 2026-11-04 fix covered one test;
  the rest still read a PID file as soon as it existed, and an empty read gave
  PID 0. That flaked `session_shutdown kills running jobs without notifying` in
  CI. `alive()` now throws on a non-positive PID, and the escaper cleanup no
  longer risks `kill(0, SIGKILL)` on the test runner's own process group.

## 2026-11-04: Shutdown test PID readiness

- Wait for positive PIDs in the shutdown test, rather than just PID file existence.
  Shell redirection can expose an empty file before `echo` writes; reading it as
  PID 0 made the liveness assertion probe the test's own process group.
- Add regression coverage for missing, empty, zero, and invalid PID files.

## 2026-11-01: Identifiers (#58)

Renamed to this bundle's `resource:name` grammar, so session data and process
globals from upstream builds are not recognised:

- Directory and package: `extensions/pi-jobs` (`@woksin/pi-jobs`) became
  `extensions/pi-job` (`pi-job`).
- Global symbols: `pi-jobs.liveManagers` became `job:managers`, and
  `pi-jobs.sessionOwners.v2` became `job:owners`. Owners keep their internal
  protocol `version`, so the key carries none. The `.v1` migration is removed.
- Message types: `pi-jobs` became `job:completion`, and `pi-jobs-reload` became
  `job:reload-notice`.
- Tool `job_output` became `job_read`; command `/jobs` became `/job`.
- Display prefixes in notices and logs read `pi-job:`.

## 2026-10-31: Shared Oxc tooling (#42)

- Source, tests, scripts, and Markdown are formatted with the bundle's shared Oxc
  configuration, so these files no longer claim byte-for-byte parity with
  upstream; the import commit remains the reference for comparing local changes.
- The shared base's unused-local checks now apply here too: removed the unused
  test binding, used Node's actual asynchronous cleanup-hook type, and explicitly
  discarded test-registration promises (the Node runner tracks the tests). Test
  message fixtures describe both string and text-block content.
- Shared tools and development dependencies live at the repository root.

## 2026-10-29: Tool checks for `job_watch` (#26)

`job_watch` accepts `toolCheck` instead of `check`: one Pi tool call per interval
through the kept `ctx.executeTool`, with an optional `match` on the result. Usage,
allowlist, and lifecycle are in [TOOL-CHECKS.md](TOOL-CHECKS.md).

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
- Known gap: codemode script checks are not supported, because `codemode` is
  `model-only` and `executeTool` cannot run it. Planned for #9 if Pi gains a way
  for extensions to run codemode scripts.

## 2026-10-29: Pi `executeTool` contract for #9 (#26)

- `test/pi-execute-tool.contract.test.ts` (new, local): pins the Pi behaviour
  that `job_watch` tool checks will rely on. Calls through a tool's kept
  `ExtensionToolContext` after that call returned:
  - work while idle, during another streaming run, and after compaction;
  - leave no nested-call record on any saved message;
  - run `tool_call` hooks, which can block them; ids are `<caller id>/<n>`;
  - fail without running after `/tree` to a point with no assistant message;
  - throw a stale-context error after reload.

## 2026-10-29: Typecheck (#12)

Upstream never typechecks; it relies on its tests. Added `tsconfig.json`
(extending the bundle's strict `tsconfig.base.json`) and made `check` run
`tsc --noEmit`, plus `node --check` for the plain-JavaScript `e2e/*.mjs`. Added
`typescript` and `@types/node` dev dependencies like the other workspaces
(`@types/node` follows the bundle's Node.js 24 floor).

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

## 2026-10-29: Integration (#12)

Manifest only; this step changed no file under `src/`, `test/`, or `e2e/`.

- `package.json`: marked `private`, removed `publishConfig`.
- `package.json`: added a `check` script, since CI runs `npm run check` for each
  changed workspace and upstream has none.
- `package.json`: added `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`
  dev dependencies, matching the bundle's Pi pin (now 1.4.0), so upstream's
  `test/runtime.ts` resolves a local runtime instead of a user installation.
- Root `package.json`: added the workspace and the `pi.extensions` entry.
- `scripts/verify-bundle.mjs`: asserts the `job_*` tools and `/job` command.
- Known gap: pi-jobs registers no widgets or custom tool renderers, so the
  `AGENTS.md` spacing rules do not apply yet. Recheck when adding UI.
- Known gap: jobs survive `/reload` in the same process, not a Pi restart.

## 2026-10-29: Vendored

Imported from upstream; see [UPSTREAM.md](UPSTREAM.md). Upstream's changelog was
cleared at import; for earlier history see the
[source changelog](https://github.com/woksin/pi-jobs/blob/a1c27af538b059815beddbb4c4f2c98cfe1eb3e9/CHANGELOG.md).
