# Personal Pi Extensions

Personal Pi bundle: one install, multiple independent extensions. No npm publication
or TypeScript build required. Requires Pi 1.4.0+ and Node.js 24+.

## Install

### Local checkout (recommended for editing)

```bash
pi install /absolute/path/to/pi-personal
```

Pi loads files from this checkout without copying them. Edit code, then run `/reload`
in Pi. Local installs do not install dependencies; these extensions currently use
only Node built-ins and Pi-provided runtime modules.

### GitHub

```bash
pi install git:github.com/zacheryph/pi
```

Pi loads the same root manifest from its managed Git checkout, not your development
checkout. Push your changes, then update that installation:

```bash
pi update git:github.com/zacheryph/pi
```

Use `pi list` to inspect installed sources. When switching from Git to local, remove
that Git source first with `pi remove git:github.com/zacheryph/pi`. Do not load both
copies, another subagents extension, another `todo` extension, or another
background-jobs extension alongside this bundle: duplicate tools and commands can
conflict. When migrating from
`@juicesharp/rpiv-todo`, remove it with `pi remove npm:@juicesharp/rpiv-todo` before
loading the bundle's tasks extension. Existing rpiv plans are not auto-imported.

Install commands above configure personal scope. Add `--local` to install for one
project instead; project resources load after project trust is granted.

### Try without installing

From this repository:

```bash
pi -e .
```

Use `pi config` to enable or disable individual extensions within the bundle.

## Layout

```text
pi-personal/
├── package.json                         # bundle manifest + private dev workspace
├── tsconfig.base.json
├── skills/
│   ├── babysit-pr/                      # drives a pull request to green
│   ├── execute-roadmap/                 # carries out a chosen roadmap
│   └── make-it-easy/                    # roadmap-planning skill
│       ├── SKILL.md
│       └── references/                  # one file per phase, template, worked example
├── extensions/
│   ├── pi-dashboard/
│   │   ├── src/index.ts                 # session reporter + /dashboard command
│   │   ├── src/hub/server.ts            # web hub (plain Node, not a Pi extension)
│   │   ├── test/
│   │   └── docs/plan.md                 # research and phased plan
│   ├── pi-jobs/                         # vendored
│   │   ├── src/extension.ts             # job_* tools + /jobs command
│   │   ├── test/
│   │   └── UPSTREAM.md
│   ├── pi-stash/
│   │   ├── src/index.ts                 # stash_* tools + /stash commands
│   │   └── test/
│   ├── pi-subagents/                    # vendored fork
│   │   ├── src/index.ts                 # subagent tools + /subagents:* commands
│   │   ├── test/
│   │   ├── docs/
│   │   ├── LICENSE
│   │   └── UPSTREAM.md
│   ├── pi-subagents-worktrees/          # vendored
│   │   ├── src/index.ts                 # worktree WorkspaceProvider + /subagents-worktrees
│   │   ├── test/
│   │   └── UPSTREAM.md
│   ├── pi-system-insights/
│   │   ├── src/index.ts                 # /system:* commands
│   │   └── test/
│   ├── pi-tldr/
│   │   ├── src/index.ts                 # /tldr command + session naming
│   │   └── test/
│   └── pi-todo/                         # vendored engine, local UI
│       ├── src/index.ts                 # todo tool + /todos:* commands
│       ├── test/
│       ├── docs/comparison.md           # base-selection report
│       └── UPSTREAM.md
└── packages/
    └── pi-session-tree/                 # shared library, not an extension
        ├── src/index.ts                 # cross-session registry (globalThis)
        └── test/
```

Each extension directory is an npm workspace with its own `package.json`,
`tsconfig.json` (extending the root base), and `check`/`test` scripts.

Root `pi.extensions` lists entry points explicitly. Pi loads each as its own
extension; helper files and tests are not loaded as extensions. `packages/` holds
libraries shared by several extensions. They are workspaces with no `pi` entry, and
extensions import them by relative path. Workspaces simplify
development commands. All manifests are private;
nothing needs publishing.

## Extensions

### pi-dashboard

Local web dashboard of running interactive Pi sessions at
`http://127.0.0.1:7317/`; `/dashboard` opens it. Cards are grouped by working
directory and show session name, `--agent` profile, model and thinking level,
context usage, live status (idle, working, running a tool, compacting, or
waiting on a dialog, which sorts first), and task, subagent and stash counts.
A card opens a detail page with the task list and history, subagents, recent
tool calls, stash index with on-demand previews, usage and cost, and
pi-blackhole memory counts. **Focus** jumps to the session's cmux panel and
raises cmux. A filter box and opt-in browser notifications (waiting or
finished sessions) round out the index. pi-todo and pi-stash publish their state as
`pi-todo:snapshot` / `pi-stash:snapshot` events on the session's `pi.events`
bus for this and other extensions.

The first interactive session starts a detached hub; sessions connect to it
over a unix socket in `~/.pi/agent/dashboard/`, and it exits 15 seconds after
the last one quits. Print-mode runs and subagent children are not shown. Port
and Node binary are set in `~/.pi/agent/dashboard.json`. Loopback only. See
[extension docs](extensions/pi-dashboard/README.md) and the
[plan](extensions/pi-dashboard/docs/plan.md).

### pi-jobs

Background shell jobs and watches that wake the agent when they finish, vendored
from [`woksin/pi-jobs`](extensions/pi-jobs/UPSTREAM.md) with local additions.
`job_start` runs a command in its own process group and returns immediately;
`job_watch` re-runs a shell check until it succeeds, fails, or its output changes.
With `toolCheck` it instead polls a read-only Pi tool, such as an MCP tool, until a
condition on its result holds ([tool checks](extensions/pi-jobs/TOOL-CHECKS.md)).
The agent ends its turn instead of polling, and completions arrive as one batched
follow-up message.
`job_list`, `job_output`, and `job_kill` inspect and stop work; `/jobs` lists or
kills jobs for the user. POSIX only. Logs live under `~/.pi/agent/jobs/` for seven
days. Do not also install `npm:@woksin/pi-jobs`. See the
[upstream README](extensions/pi-jobs/README.md) for delivery guarantees and limits.

### pi-stash

Keeps large text (search results, file snapshots, tool output, worker findings)
outside the model context and hands back a short handle such as
`stash:auth-findings@3f9a1c2b7d01`. The model and its subagents then read only the
slices they need.

- `stash_put` stores literal `content`, a `path` inside the working directory,
  the full result of an earlier tool call (`toolCallId`), or an existing `handle`.
  It returns a receipt with a short preview; it never echoes the content.
- `stash_get` reads a bounded, line-numbered slice: `lines`, `grep`, or `jsonPath`
  (head by default; 16 KB default, Pi's 50 KB / 2,000-line cap at most).
- `stash_list` lists this branch's entries.

Content is stored once by SHA-256 under `$PI_STASH_DIR` or `~/.pi/agent/stash/`.
The name index lives in the session, follows `/tree`, and survives compaction and
resume; full handles also work from other sessions, which is how a parent and its
subagents share data. A subagent's entries also appear in its parent's and
ancestors' stash as they are stored. Explore and Plan can read handles; Explore can
also stash large findings. `/stash` browses entries and `/stash:gc` expires unused content
(`retentionDays`, default 30, in `~/.pi/agent/stash.json`).

Stashed text is plaintext on local disk and is not redacted. See
[extension docs](extensions/pi-stash/README.md).

### pi-subagents

The built-in `orchestrator` profile manages long-running projects with categorized
todos, specialist delegation, and follow-ups in prior workers' sessions. Use
`pi --agent orchestrator` or delegate with `subagent_type: "orchestrator"`.

The built-in `reviewer` profile verifies finished work: it runs the project's
checks, judges each acceptance criterion with evidence, and reports
`Verdict: PASS`, `FAIL`, or `BLOCKED` without fixing anything. The orchestrator
completes an implementation task only after a reviewer that did not do the work
passes it.

Personal copy of [`gotgenes/pi-packages/packages/pi-subagents`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents).
Provides `subagent`, `get_subagent_result`, and `steer_subagent`, plus
`/subagents:settings`, `/subagents:sessions`, `/subagents:watch`, and
`/subagents:agents` (read-only browser for agent definitions).

Background agents use a compact widget above Pi's editor:

```text
── ● Subagents ────────────────────────────────────────────
01:23  Explore: Find auth files                  ⠋ reading…
00:45  Agent (twin): Add tests                   ⠙ thinking…
--:--  Explore: Review changes                     ◦ queued
```

Only a top rule is drawn; Pi's own Working border, editor, and footer stay intact.
Each agent occupies one row, with task identity left and activity/outcome right.
Model/token/turn stats remain in tool results, not the widget. Finished agents keep
upstream linger behavior. Short terminals collapse overflow into a `+N more` row.

In Pi fullscreen mode, `Ctrl+Alt+S` or `/subagents:watch` toggles a passive
right-side watch overlay. It tails assistant text and compact tool summaries in
stacked agent sections, without taking editor focus or changing agent execution.
It starts closed. `/subagents:settings` selects quarter, third (default), half, or
two-thirds width and default visibility. Explicit show/hide wins for the current
session, including later agent runs. Regular mode keeps the compact widget only:
Pi 1.1.0 overlays can contaminate terminal scrollback there.

Custom agents are read from `.pi/agents/<name>.md` in the project where Pi runs, or
`~/.pi/agent/agents/<name>.md`; they are not definitions inside this bundle.
See [upstream README](extensions/pi-subagents/README.md),
[configuration](extensions/pi-subagents/docs/configuration.md), and
[provenance/local changes](extensions/pi-subagents/UPSTREAM.md).

### pi-subagents-worktrees

Runs opted-in subagent types in a temporary git worktree, so parallel
implementation workers never edit the same checkout. Vendored from
[`gotgenes/pi-packages`](extensions/pi-subagents-worktrees/UPSTREAM.md). List the
agent types to isolate in `~/.pi/agent/subagents-worktrees.json` or the project's
`.pi/subagents-worktrees.json`:

```json
{ "worktreeAgents": ["general-purpose"] }
```

A child that changes nothing leaves no trace. A child with changes has them
committed to a `pi-agent-<id>` branch, and its result says how to merge it. A
failed cleanup leaves the worktree on disk instead of deleting work; session
start warns about such worktrees and about unmerged `pi-agent-` branches, and
`/subagents-worktrees` lists preserved worktrees and removes one after
confirmation. Without a config file nothing is isolated. Do not also install
`npm:@gotgenes/pi-subagents-worktrees`. See the
[upstream README](extensions/pi-subagents-worktrees/README.md).

### pi-system-insights

Read-only session inspectors:

- `/system:prompt` — current Pi system prompt; tool/skill catalogs folded into redaction markers.
- `/system:tools` — accessible tools; Enter shows declaration/schema and prompt metadata.
- `/system:skills` — discovered skills; Enter shows description and loading evidence.

Fullscreen viewers use a centered 80% width/height overlay; regular mode uses a
custom screen to avoid overlay scrollback contamination. Each view has a title,
rounded border, padded content, and help footer. Indexes omit descriptions;
details align fields and show one full tool schema.

Skill loading tracks the current branch and becomes dirty after compaction.
Badges are green for fresh loading evidence, grey for unobserved/dirty state;
footer explains colors. Esc returns from details to list, then closes.
Viewers never load skill instructions or change tools/settings. See
[package README](extensions/pi-system-insights/README.md) for controls and evidence limits.

### pi-todo

Dependency-aware task tracking built on
[`@99percentpeople/pi-todo`](extensions/pi-todo/UPSTREAM.md). One atomic `todo`
tool: additive `upsert` preserves omitted tasks; `replace`, `remove`, and `clear`
make deletion explicit. Stable keys, cycle checks, optional revision guards, and
branch-scoped persistence work with direct and nested codemode calls.

Updates can carry a `message` (completion summary, findings, handoff). It is
recorded in task history and flagged until reviewed, so outcomes survive later
subagent or tool output. The widget counts unreviewed messages, shows excerpts, and
puts those tasks first.

Above-editor widget matches subagents' compact top-rule/identity/status layout.
`/todos` or `/todos:list` opens a searchable browser matching insights, with All,
Unreviewed and Recent views plus per-task activity timelines. `/todos:review` opens
unreviewed messages. Commands: `/todos:add`, `/todos:update`, `/todos:remove`,
`/todos:clear`, `/todos:settings`.
Settings layer global `todos.json` with project `.pi/todos.json`.

User additions never start/steer a turn. Changed state syncs to the next model
request by default; no auto-removal, auto-completion, or implicit subagent dispatch.
Multiple active tasks remain possible for parallel work. See
[usage/settings](extensions/pi-todo/README.md) and
[comparison/decision report](extensions/pi-todo/docs/comparison.md).

### pi-tldr

`/tldr` displays a concise model-generated recap of the current session: initial
premise, major findings/turning points, and current status. It uses a centered
modal in fullscreen TUI, or a separate screen in regular TUI.

After the first user prompt of a new interactive session, it asynchronously
suggests a short hyphen-separated name (2–4 words). `/tldr` opens immediately
with an in-modal loading indicator and refreshes only extension-generated names,
never manual names. Pi manages the terminal title itself. Model selection
prefers the latest available Haiku or Luna.

Configure globally in `~/.pi/agent/tldr.json`, with a project override in
`.pi/tldr.json`:

```json
{ "model": "auto", "setSessionName": true }
```

Set `setSessionName` to `false` to keep summaries while disabling extension-driven
session naming. See [extension docs](extensions/pi-tldr/README.md).

## Skills

Root `pi.skills` loads `skills/`, so a bundle install provides these. Force one
with `/skill:<name>`. Skills for working on this repository itself live in
`.agents/skills/` and are not part of the bundle.

### babysit-pr

Drives one pull request to green CI with every review comment handled, without
polling. It watches the checks of the PR's head commit SHA (never the moving PR
number) with `job_watch`, or `job_start` with `gh run watch`, and ends its turn
until they finish. A failed check gets its log read and is classified: caused by
the PR (reproduce locally with the same command, smallest fix, rerun, push),
infrastructure (rerun the failed jobs once), or pre-existing (reported, not
fixed). Review comments in scope are fixed and answered; larger asks go back to
you. It stops after three attempts per check, on a decision only you can make, or
on a conflict with the base branch. Never skips tests, pushes empty commits,
rewrites others' history, approves, or merges. Uses `gh` when authenticated,
otherwise the GitHub MCP tools.

### make-it-easy

Turns a project or goal into implementation roadmap options, following Kent
Beck's "make the change easy (warning: this may be hard), then make the easy
change". The work is staged, and each stage has a gate:

1. **True goal:** separates the request from the outcome it serves; produces a
   goal brief with success criteria, non-goals, and what existing things may change.
2. **Inputs:** lists what the new work must know or receive (placement,
   identity, config, dependencies, policy) and designs how each is supplied so
   producer and consumer stay decoupled, for example discovery by tag instead of
   hardcoded IDs.
3. **What exists:** researches prior art, conventions, and friction, and decides
   per item whether to fix first, work around, or leave.
4. **Options:** two or three different strategies (always including a
   least-preparation baseline) with a recommendation.
5. **Roadmap:** ordered, independently shippable steps that keep tidying
   separate from behavior change and end with a small, easy change.

It plans and writes `docs/roadmaps/<slug>.md`; it does not implement. It overlaps
with [`@firstpick/pi-extension-grill-me`](https://www.npmjs.com/package/@firstpick/pi-extension-grill-me)
only in stage 1. If its `questionnaire` tool is installed the skill uses it to
batch questions, and it reuses an existing `GRILL-ME.md` instead of re-asking.
Nothing here depends on it.

### execute-roadmap

Carries out a chosen make-it-easy roadmap. Each step becomes a `todo` with its
`Depends on` mapped to `dependsOn`; ready steps go to subagents (in parallel only
when their files do not overlap); a `reviewer` that did not do the work checks
every step against its "Done when" and "Verification" lines before it is
committed and completed. Two failed repair rounds block a step. A finding the roadmap did not anticipate
stops the run and lands in the document's open questions instead of an
improvised plan. The roadmap document stays the plan of record: its `Status:`
and per-step `Landed:` lines are updated as work lands, so a later run resumes
from the first unfinished step. It commits locally and pushes only when asked.

## Development

Runtime loading needs no build. Install development dependencies only for checks
and tests:

```bash
npm install --ignore-scripts
npm run check
npm test
npm run verify:bundle
```

`verify:bundle` checks root-package discovery and tool and skill registration in temporary
settings, without model calls or changes to your Pi configuration.

These check/test commands cover every development workspace. To run one
workspace, pass it with `-w`, e.g. `npm test -w extensions/pi-todo`. Pi modules
are dev dependencies for testing and peer dependencies for runtime; Pi supplies its
own modules when loading extensions.

GitHub Actions runs `check` and `test` in parallel jobs per extension workspace,
plus one `verify:bundle` job whenever any extension is selected. Pull requests
select extensions with changes under their directory; changes to root
manifests/lockfiles, `.nvmrc`, shared TypeScript settings, workflows, or scripts
select all extensions. Pushes to `main` always check and test all extensions.
Unrelated PR changes skip the extension matrix. Matrix selection is tested with
`node --test scripts/select-test-extensions.test.mjs`. CI reads its Node.js
version from `.nvmrc`; `nvm use` or `fnm use` picks up the same version locally.

Optional public API declaration generation (not needed for extension loading):

```bash
npm run build:types
```

To work on one extension without other configured extensions:

```bash
pi --no-extensions -e ./extensions/pi-subagents/src/index.ts
```

### Add another extension

1. Create `extensions/<name>/` with `src/index.ts`, `test/`, a private
   `package.json` with `check` (`tsc --noEmit`) and `test` scripts, and a
   `tsconfig.json` extending `../../tsconfig.base.json`. `extensions/pi-tldr/` is
   the smallest example. CI runs both scripts without `--if-present`.
2. In root `package.json`, add the directory to `workspaces` and its entry point
   to `pi.extensions`, then run `npm install --ignore-scripts` to update the
   lockfile.
3. Assert its tools and commands in `scripts/verify-bundle.mjs`.
4. Run `/reload` (or restart Pi). No reinstall needed for a local checkout.

Keep helper modules beside their entry point, not registered separately. Add
third-party runtime dependencies to the bundle's root `dependencies` so Git installs
can install them; for local installs run `npm install --ignore-scripts` yourself.
Nested manifests alone do not expose another extension through the root bundle.

To copy a third-party extension into the repository, follow the
[`vendor-extension` skill](.agents/skills/vendor-extension/SKILL.md): a verbatim
import commit, then integration, with provenance and local changes tracked in the
extension's `UPSTREAM.md`.

## License

Vendored subagents code retains its upstream [MIT license](extensions/pi-subagents/LICENSE).
Vendored todo engine retains its upstream [MIT license](extensions/pi-todo/LICENSE).
Vendored jobs code retains its upstream [MIT license](extensions/pi-jobs/LICENSE).
Vendored worktrees code retains its upstream [MIT license](extensions/pi-subagents-worktrees/LICENSE).
