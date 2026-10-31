# Vendored pi-subagents

This personal fork was imported from
[`gotgenes/pi-packages/packages/pi-subagents`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents),
which was itself forked from [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).

- Source: https://github.com/gotgenes/pi-packages
- Directory: `packages/pi-subagents`
- Commit: `29bfbfe605d726c78f6120977b08666716e048f2`
- Upstream version: `23.2.0`
- License: MIT; original notice retained in `LICENSE`.

This is an editable source copy, not a Git submodule or npm runtime dependency.
The repository root exposes `src/index.ts` alongside the other bundled extensions.
Install the root bundle; do not separately install the published upstream extension.

## Initial local adaptations

- Copied source, tests, docs, changelog, README, license, and type-build tooling.
- Omitted upstream media and contributor-only `.pi`/`AGENTS.md` configuration.
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

## Personal widget changes

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

## Personal watch overlay

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

## Personal profile UX

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

## Personal prompt fragments

- Added `fragments: [name, ...]` to custom agent definitions.
- Resolve names only in the winning profile's `agents/fragments/<name>.md`;
  plain Markdown fragments precede the profile body in declaration order.
- Main and child profiles share composition; selected execution retains expanded
  text across resume and background queueing.
- Discovery stays lazy, project fragment reads require trust, and invalid/missing
  references fail selected execution rather than dropping instructions.
- Read-only `/subagents:agents` details show fragment sources and composition.

## Latest-model defaults

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

## Dev dependency pins

- Pi dev dependencies bumped from 1.1.0 to 1.4.0 (2026-10-29).
- `typebox` dev dependency pinned to `1.3.27`, the exact version Pi 1.4.0 bundles,
  so tests exercise the schema library extensions receive at runtime.
- `engines.node` raised from `>=22` to `>=24` and `@types/node` to `^24`, matching
  the bundle's supported Node.js version.
- `vitest` dev dependency raised from `^4.1.11` to `^5.0.5`; no test changes needed.
- `test/ui/read-only-browser.test.ts`: the `plain()` helper also strips Pi's
  fake-cursor markers. pi-tui 1.4.0's `Input` wraps its cursor cell in zero-width
  APC markers that the TUI resolves to the same reverse video 1.1.0 emitted
  directly, so the rendered output is unchanged.

## Shared compiler and test config

- `vitest.config.ts`: dropped the `#src`/`#test` resolve aliases. Vite resolves
  the package.json `imports` map itself; `tsconfig.json` keeps its `paths`
  because TypeScript does not add file extensions to extensionless `imports`.
- Root `tsconfig.base.json` now also enables `verbatimModuleSyntax`,
  `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`,
  `noUnusedLocals`, and `noUnusedParameters`; this source needed no changes.

## Personal pi-stash integration

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

## Personal reviewer profile

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

## Service publication per session

- Upstream kept one `globalThis` slot. Each in-process child session loads the
  extension again, replaced the parent's service at load, and deleted the slot on
  shutdown, leaving the parent with no service until its next reload.
- `src/service/service.ts` now keeps every published service under
  `Symbol.for("@gotgenes/pi-subagents:services.v1")`, pending from the factory
  until `session_start`. The newest pending service is the default while a load
  is in progress (so companions such as pi-subagents-worktrees still register
  their provider from their factory, in children too); otherwise the outermost
  started one is. The legacy slot mirrors the default.
- A starting session drops older pending publications, and a child whose
  creation fails discards the ones its load made, so a load that never starts
  cannot stay the default. `unpublishSubagentsService(service)` removes only its
  own publication (the argument is now required).
- `getSubagentsService(sessionId?)` can return a specific session's service.
- Tests: `test/service/service.test.ts`, and parent/child, load-only,
  companion and failed-child cases in `test/composition-root.test.ts`.

## Companion typechecking

- `package.json` `imports`: each `#src/*` and `#test/*` target gained a `types`
  condition (`./src/*.ts`) beside the unchanged `default`, so a companion
  extension that imports this source by relative path (pi-subagents-worktrees)
  can typecheck it without mapping `#src` itself. This package's own
  `tsconfig.json` paths and its runtime resolution are unchanged.

## Spawn handoff and run identity on child events

- The `subagent` tool takes `todos` and `todo_scope`, and `SpawnOptions` takes
  `todos` and `todoScope`. They become a `SubagentHandoff`
  (`src/lifecycle/child-lifecycle.ts`) that the core forwards untouched on
  `subagents:child:session-created` for pi-todo to act on.
- `subagents:child:session-created`, `bound` and `disposed` also carry `agentId`
  (the record id) and `toolCallId` (the parent's tool call; absent for service
  spawns), so a parent-side extension can tie a child session to the spawn.
- Tests: `test/handoff-sdk.test.ts` (a real orchestrator session spawning through
  the tool) plus unit tests in the lifecycle, tools and service suites.

## Development

Run from this repository's root:

```bash
npm install --ignore-scripts
npm run check
npm test
```

`npm run build:types` optionally creates the declaration bundles referenced by
`exports.types`. Pi loads TypeScript source directly and does not need those files.
Companion extensions should import this vendored source through a relative path,
e.g. `../pi-subagents/src/service/service.ts`, rather than assuming the published
`@gotgenes/pi-subagents` package is installed in a Git-installed bundle.

## Updating the copy

Fetch upstream in a separate checkout, compare its `packages/pi-subagents` directory
against this directory, and merge changes while preserving local modifications and
license notices. Update the commit/version above after each import. `pi update`
updates the bundle's Git checkout; it does not merge upstream into this vendored copy.
