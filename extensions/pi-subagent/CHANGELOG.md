# Changelog

Local changes to this vendored copy, newest first. Where it came from is
recorded in [UPSTREAM.md](UPSTREAM.md).

## 2026-11-03: Caller-chosen working directory

`subagent_start` takes an optional `cwd`: an existing directory, absolute or
relative to the parent's, that the child runs in. It lets an orchestrator hand a
worker a git worktree it created, in any repository, instead of relying on a
workspace provider chosen per agent type.

- `src/lifecycle/spawn-cwd.ts` (new): resolves and checks the path. A missing
  directory or a non-string is refused before anything is spawned.
- `src/tools/agent-tool.ts`: the `cwd` parameter and its guidance line; refused
  together with `resume`, since a resumed agent keeps its directory.
- `src/tools/spawn-config.ts`, `background-spawner.ts`, `foreground-runner.ts`,
  `src/lifecycle/subagent-manager.ts`: thread `cwd` like `handoff`.
- `src/lifecycle/subagent.ts`: with a `cwd`, `run()` skips the workspace provider,
  so nothing is disposed when the run ends and `resumeRefusal` never reports
  `workspace-disposed` for it.
- `src/service/service.ts`, `service-adapter.ts`: `SpawnOptions.cwd`, checked
  against the session's cwd; a bad one throws.
- `src/lifecycle/child-lifecycle.ts`, `create-subagent-session.ts`:
  `subagent:session:created` carries the child's effective `cwd`.
- Tests: `test/lifecycle/spawn-cwd.test.ts` (new), `test/cwd-sdk.test.ts` (new:
  a real orchestrator session spawns a worker with a relative `cwd` and resumes
  it), and cases in `subagent.test.ts`, `agent-tool.test.ts`,
  `service-adapter.test.ts`; `handoff-sdk.test.ts` expects the new `cwd` field.

## 2026-11-01: Questions through pi-ask (#62)

The `ask_parent` tool is gone. A child asks with the bundled pi-ask's `ask`,
which the core reaches through a session-tree service: before a child's
extensions bind, `createSubagentSession` offers the run's question recorder as
the child's `ask:route`, adds `ask` to the child's tool allowlist as protocol,
and withdraws the service when the child is disposed. The question still lands
on the record as `pendingQuestion`, and every result carrier still renders it
with the resume call that answers it.

## 2026-11-01: Identifiers (#59)

Every identifier follows this bundle's `resource:name` grammar, so session data
and process globals from upstream builds are not recognised. The directory and
package moved from `extensions/pi-subagents` (`@gotgenes/pi-subagents`) to
`extensions/pi-subagent` (`pi-subagent`).

- Events: `subagents:<event>` became `subagent:<event>` (created, started,
  resuming, resumed, completed, failed, compacted, steered), and
  `subagents:update` became `subagent:notified`. Child-session events
  `subagents:child:*` became `subagent:session:*` (`session-created` is now
  `subagent:session:created`). Settings events are `subagent:settings:loaded`
  and `subagent:settings:changed`.
- Session entries: `subagents:record` became `subagent:record`, and
  `pi-subagents:main-agent-profile` became `agent:profile`.
- Message types: `subagent-notification` became `subagent:completion`,
  `subagent-update` became `subagent:update`, `subagent-workspace-notice` became
  `subagent:workspace-notice`, and `subagents:turn-budget-warning` became
  `subagent:turn-budget-warning`.
- Global symbols: the upstream `@gotgenes/pi-subagents:service` slot is removed;
  publications live under `subagent:services`.
- Tools: `subagent` became `subagent_start`, `get_subagent_result` became
  `subagent_get`, `steer_subagent` became `subagent_steer`, and `notify_parent`
  became `parent_notify`.
- Commands: `/subagents:watch|settings|sessions` became `/subagent:*`, and
  `/subagents:agents` became `/agent`, since it browses agent definitions the
  main agent also uses through `--agent`.
- UI keys: widget `agents` became `subagent:widget`, the watch host
  `subagent-watch-host` became `subagent:watch`, status `subagents` became
  `subagent:status`, and status `main-agent` became `agent:status`.
- Settings file: `subagents.json` became `subagent.json`.

## 2026-10-31: Shared pi-ui (#51)

UI primitives now come from the bundle's `packages/pi-ui` library instead of
local copies:

- `src/ui/read-only-browser.ts` (the adapted `pi-system-insights` viewer) is
  removed. `/subagents:agents` builds an `ExplorerView` and opens it with
  `showExplorer`; details are structured blocks (fields, then Description, Tool
  guideline, Body, Fragments and Composed instructions sections). The regular
  renderer fallback is gone: pi-ui supports Pi's fullscreen TUI only.
- `src/ui/widget-renderer.ts` keeps ordering, linger, queued counts, budgets and
  the elapsed/prompt-mode width thresholds, and describes rows as a `WidgetView`
  for `renderWidget` (overflow groups `running`/`finished`). Status text is
  pre-clipped to 40% of the row as before.
- `src/ui/glyphs.ts`, `src/ui/labeled-rule.ts` and `src/ui/bounded-lines.ts` are
  removed in favor of pi-ui's `ICONS`/`SPINNER`, `labeledRule` and `BoundedLines`
  (renamed glyphs: `toolCall` → `tool`, `agentsHeading` → `agents`,
  `agentsActive` → `active`, `agentsIdle` → `idle`).
- `watchText` and the main-profile notice use pi-ui's `sanitizeText`; lone CR now
  becomes a line break, tabs expand to four spaces, and an incomplete CSI keeps
  its parameter bytes as plain text.
- `src/ui/watch-overlay.ts` owns its passive overlay through `PassiveOverlay`
  (non-capturing, own handle, hide on width change). Visibility, linger and
  repaint cadence are unchanged.
- The `/subagents:sessions` navigator, `/subagents:settings` dialogs and tool/
  notification renderers keep their own presentation.

## 2026-10-31: Remove standalone declaration bundling (#43)

- Dropped the TypeScript 7 / Rolldown declaration bundles added in #42 and the
  optional `build:types` script. Public API type exports reference TypeScript
  source directly; Pi loads that source without a declaration or JavaScript
  build.
- Companion extensions import this vendored source through a relative path,
  e.g. `../pi-subagent/src/service/service.ts`, rather than assuming the
  published `@gotgenes/pi-subagents` package is installed in a Git-installed
  bundle.

## 2026-10-31: Shared Oxc and TypeScript 7 tooling (#42)

- Apply the bundle's Oxfmt formatting and Oxlint correctness checks to source,
  tests, scripts, and documentation.
- Keep terminal-control matching explicit with narrowly scoped lint comments.
- Resolve private import aliases to explicit `.ts` files so sibling workspace
  consumers can load the service through standard package import resolution.
- Generate public declarations with TypeScript 7 and bundle them with Rolldown;
  no TypeScript 6 compiler API is required.

## 2026-10-31: Orchestrator todo handoff (#40)

- The orchestrator prompt (`src/config/default-agents.ts`) tells it to hand each
  worker its tasks with `handoff: { todos: { keys } }`, which pi-todo turns into a
  claim the worker updates directly. Its note that workers' todo edits never reach
  the ledger now covers only edits outside a handoff.
- `test/todo-handoff-sdk.test.ts`: a real orchestrator (pi-subagents + pi-todo)
  hands two tasks to a worker through the tool and checks the veto, the scoped list,
  attributed updates, a new task joining the claim, and the release.

## 2026-10-31: Spawn handoff and run identity on child events (#35)

- The `subagent` tool and `SpawnOptions` take a generic `handoff` object whose
  top-level keys belong to other extensions (pi-todo reads `todos`).
  `normalizeHandoff` (`src/lifecycle/child-lifecycle.ts`) only checks it is a JSON
  object within `MAX_HANDOFF_BYTES`, copies and deep-freezes it; the core forwards
  it untouched on `subagents:child:session-created`. New handoff data needs no
  change here.
- `subagents:child:session-created`, `bound` and `disposed` also carry `agentId`
  (the record id) and `toolCallId` (the parent's tool call; absent for service
  spawns), so a parent-side extension can tie a child session to the spawn.
- Tests: `test/handoff-sdk.test.ts` (a real orchestrator session spawning through
  the tool) plus unit tests in the lifecycle, tools and service suites.

## 2026-10-31: Companion typechecking (#33)

- `package.json` `imports`: each `#src/*` and `#test/*` target gained a `types`
  condition (`./src/*.ts`) beside the unchanged `default`, so a companion
  extension that imports this source by relative path (pi-subagent-worktree)
  can typecheck it without mapping `#src` itself. This package's own
  `tsconfig.json` paths and its runtime resolution are unchanged.

## 2026-10-31: Personal reviewer profile (#36)

- `src/config/default-agents.ts`: new built-in `reviewer` (read-only tools, inherited
  model, `replace` mode). It verifies finished work against its acceptance criteria,
  may run the project's checks, never edits files or git state, and starts its report
  with `Verdict: PASS`, `FAIL`, or `BLOCKED`, followed by per-criterion evidence.
- `AgentTypeRegistry.DEFAULT_AGENT_NAMES` lists it after Plan.
- The orchestrator prompt names reviewer for verification and gains one bullet:
  review each implementation task with a reviewer that did not do the work, resume
  the implementer on `FAIL`, and stop after two failed rounds.
- Tests: `test/config/agent-types.test.ts` (profile, tools, orchestrator wording,
  user override); fixture user agent `reviewer` renamed `linter` there, and the
  agents-browser lists now include the built-in.

## 2026-10-31: Latest-model defaults (#38)

- `src/session/model-resolver.ts`: a model string ending in `@latest`
  (`[provider/]family@latest`) resolves to the newest available model whose id
  contains `family`, comparing the numbers in the id (so `claude-haiku-5-5` beats
  `claude-haiku-4-5-20251001`). No match is an error string, so config-specified
  models fall back to the parent like any other unresolved model.
- `src/main-agent-profile.ts`: a `provider/…@latest` profile model goes through the
  resolver instead of exact lookup.
- Explore's default model is `anthropic/claude-haiku@latest` instead of the pinned
  `anthropic/claude-haiku-4-5-20251001`, so it follows new Haiku releases and does not
  silently fall back to the parent's model when an old one is retired.
- Docs: built-in table and the `model` frontmatter rows here and in the README.

## 2026-10-30: Service publication per session (#29)

- Upstream kept one `globalThis` slot. Each in-process child session loads the
  extension again, replaced the parent's service at load, and deleted the slot on
  shutdown, leaving the parent with no service until its next reload.
- `src/service/service.ts` now keeps every published service under
  `Symbol.for("subagent:services")` (see Identifiers), pending from the factory
  until `session_start`. The newest pending service is the default while a load
  is in progress (so companions such as pi-subagent-worktree still register
  their provider from their factory, in children too); otherwise the outermost
  started one is. The upstream single slot is gone (see Identifiers).
- A starting session drops older pending publications, and a child whose
  creation fails discards the ones its load made, so a load that never starts
  cannot stay the default. `unpublishSubagentsService(service)` removes only its
  own publication (the argument is now required).
- `getSubagentsService(sessionId?)` can return a specific session's service.
- Tests: `test/service/service.test.ts`, and parent/child, load-only,
  companion and failed-child cases in `test/composition-root.test.ts`.

## 2026-10-29: Personal pi-stash integration (#13)

- `READ_ONLY_TOOLS` in `src/config/default-agents.ts` gains `stash_get` and
  `stash_list`, so Explore and Plan can read `stash:<name>@<hash>` handles from the
  bundled `pi-stash` extension. Both tools only read.
- Explore's `toolNames` additionally include `stash_put` (not the shared list), so it
  can return large findings as a handle. `stash_put` writes only to Pi's data
  directory, never the project. Explore's read-only prompt names it as the single
  exception to "no files" and asks for large findings to be stashed.
- Plan stays read-only: `stash_get` and `stash_list` only.
- The orchestrator prompt gains one bullet: brief workers with stash handles for
  shared material and ask for large results as handles.
- Children load the parent's extensions, so the tools exist there when the bundle
  is installed; without pi-stash the extra names simply match no tool.
- `test/stash-sdk.test.ts` covers Explore writing and reading, and Plan being
  refused `stash_put`, in real SDK child sessions.

## 2026-10-29: Shared compiler and test config (#17)

- `vitest.config.ts`: dropped the `#src`/`#test` resolve aliases. Vite resolves
  the package.json `imports` map itself; `tsconfig.json` keeps its `paths`
  because TypeScript does not add file extensions to extensionless `imports`.
- Root `tsconfig.base.json` now also enables `verbatimModuleSyntax`,
  `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`,
  `noUnusedLocals`, and `noUnusedParameters`; this source needed no changes.

## 2026-10-29: Dev dependency pins (#12, #15)

- Pi dev dependencies bumped from 1.1.0 to 1.4.0 (2026-10-29).
- `typebox` dev dependency pinned to `1.3.27`, the exact version Pi 1.4.0 bundles,
  so tests exercise the schema library extensions receive at runtime.
- `engines.node` raised from `>=22` to `>=24` and `@types/node` to `^24`, matching
  the bundle's supported Node.js version.
- `vitest` dev dependency raised from `^4.1.11` to `^5.0.5`; no test changes needed.
- `test/ui/read-only-browser.test.ts` (since removed by the shared pi-ui entry): the
  `plain()` helper also stripped Pi's fake-cursor markers. pi-tui 1.4.0's `Input`
  wraps its cursor cell in zero-width APC markers that the TUI resolves to the
  same reverse video 1.1.0 emitted directly, so the rendered output is unchanged.

## 2026-10-22: Personal prompt fragments

- Added `fragments: [name, ...]` to custom agent definitions.
- Resolve names only in the winning profile's `agents/fragments/<name>.md`;
  plain Markdown fragments precede the profile body in declaration order.
- Main and child profiles share composition; selected execution retains expanded
  text across resume and background queueing.
- Discovery stays lazy, project fragment reads require trust, and invalid/missing
  references fail selected execution rather than dropping instructions.
- Read-only `/subagents:agents` details show fragment sources and composition.

## 2026-10-22: Personal profile UX

- Added `/subagents:agents`: searchable read-only definitions, disabled status,
  effective fields/source paths/locks, description, then full-width Body content.
- Adapted the `pi-system-insights` viewer locally to keep standalone installs
  independent: padded rounded frame, contextual help, bounded regular screen,
  centered fullscreen overlay, keyboard navigation and fullscreen wheel scrolling.
- Added `--agent <profile>` for the initial main session only. Applies profile
  model/thinking/tools as defaults, preserves manual choices on resume/reload,
  and restores the exact saved profile body as system instructions.
- Added main-only `--agent-model <model>` for explicit initial `--agent` selection.
  Overrides the effective snapshot's model default without mutating definitions,
  reapplying on restoration, or forwarding a child override. Launchers pair it
  with core `--model` because native `getFlag` cannot read core CLI flags.
- Main MCP wildcards expand only to non-hidden tools available at startup; empty
  matches are reported in the startup notice, not treated as missing required
  tools. MCP connects asynchronously. Literal missing/hidden tools still block.
- Main profile selection requires project trust for project definitions and keeps
  delegation tools available. Child behavior is unchanged; main profile body is
  excluded from both full and portable child prompt inheritance.

## 2026-10-22: Personal watch overlay

- Added fullscreen-only `/subagents:watch` and `Ctrl+Alt+S`, with a passive right
  overlay showing always-tailing background-agent text and compact tool activity.
- Added persisted width presets (`quarter`, `third`, `half`, `two-thirds`),
  default visibility (closed), and thinking visibility (shown). Explicit session
  visibility overrides the open/closed default.
- Feed entries retain provider-emitted thinking, with themed Think / Tool / Skill
  labels and error coloring; thinking visibility changes update live overlays.
- Agents still execute in-process. Internal session-ready observer wiring allows
  live subscription before the first child event without widening the public API.
- Output buffers and repaint cadence are bounded; no transcript scrolling or
  inherited context is shown. Session shutdown/replacement releases subscriptions,
  timers, and only the overlay this fork owns.
- Regular mode remains overlay-free: Pi 1.1.0 still exhibits the scrollback defect
  documented in ADR 0007, including with one- or two-row top margins on bursts.

## 2026-10-22: Personal widget changes

- Replaced the two-line running-agent tree with a static `── ● Subagents ──`
  header rule and one line per agent. No enclosing box or bottom border.
- Layout inspired by `maplezzk/pi-extensions/packages/pi-interactive-subagents`,
  but implemented locally using Pi themes and terminal-cell width utilities.
- Elapsed time and agent type/task on the left; activity or outcome on the right.
  Model/token/turn stats remain in tool results, not the widget.
- Queued agents have individual rows and no ticking elapsed clock. Existing
  background-only filtering, completion linger, animation cadence, and viewport
  safeguards remain unchanged. Running/queued/finished order determines priority.
- Rendering honors the width passed by Pi, rather than always using terminal width.
- Agent rows now reserve one space at each edge, before elapsed time and after
  activity/outcome; header remains full-width.
- Renderer tests cover the single-line layout, static header, ANSI/Unicode,
  edge spacing, narrow screens, queued/finished outcomes, and exact overflow counts.

## 2026-10-22: Integration

- Marked package private and removed publication configuration.
- Replaced monorepo `catalog:` dev dependency versions with normal versions.
- Aligned Pi dev dependencies with installed Pi 1.1.0; host runtime peers use `*`.
- Removed lint commands requiring upstream monorepo configuration and removed the
  published-tarball verification command from the manifest. Its original script
  remains as reference, not part of local verification.
- Kept `#src/*` and `#test/*` import aliases and the original source layout.
- Root private npm workspace supplies a single development install and commands.
- Copied upstream shared TypeScript compiler settings to root `tsconfig.base.json`.
- Added a local-install notice to the upstream README.
- Adapted tests for Pi 1.1: added `Terminal.setProgramStatus` to the terminal stub,
  fixed viewport keybindings explicitly, and disabled Git commit signing only in
  the temporary-repository fixture (no personal Git settings changed).

No upstream runtime behavior was intentionally changed during import.

## 2026-10-22: Vendored

Imported from upstream; see [UPSTREAM.md](UPSTREAM.md). Upstream's changelog was
cleared at import; for earlier history see the
[source changelog](https://github.com/gotgenes/pi-packages/blob/29bfbfe605d726c78f6120977b08666716e048f2/packages/pi-subagents/CHANGELOG.md).
