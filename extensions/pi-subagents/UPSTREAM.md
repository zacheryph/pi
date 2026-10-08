# Vendored pi-subagents

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
- Renderer tests now cover the single-line layout, static header, ANSI/Unicode,
  narrow screens, queued/finished outcomes, and exact overflow counts.

## Personal watch overlay

- Added fullscreen-only `/subagents:watch` and `Ctrl+Alt+S`, with a passive right
  overlay showing always-tailing background-agent text and compact tool activity.
- Added persisted width presets (`quarter`, `third`, `half`, `two-thirds`) and
  default visibility (closed). Explicit session visibility overrides that default.
- Agents still execute in-process. Internal session-ready observer wiring allows
  live subscription before the first child event without widening the public API.
- Output buffers and repaint cadence are bounded; no transcript scrolling or
  inherited context is shown. Session shutdown/replacement releases subscriptions,
  timers, and only the overlay this fork owns.
- Regular mode remains overlay-free: Pi 1.1.0 still exhibits the scrollback defect
  documented in ADR 0007, including with one- or two-row top margins on bursts.

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
