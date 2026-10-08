# Personal Pi Extensions

Personal Pi bundle: one install, multiple independent extensions. No npm publication
or TypeScript build required. Requires Pi 1.1.0+ and Node.js 22.19+.

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
copies, another subagents extension, or another `todo` extension alongside this
bundle: duplicate tools and commands can conflict. When migrating from
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
└── extensions/
    ├── opencode-editor.ts
    ├── pi-todo/
    │   ├── src/index.ts                 # todo tool + /todos:* commands
    │   ├── test/
    │   ├── docs/comparison.md           # base-selection report
    │   └── UPSTREAM.md
    ├── pi-system-insights/
    │   ├── package.json                 # independent insights workspace
    │   ├── src/index.ts                 # /system:* entry point
    │   └── test/
    └── pi-subagents/
        ├── package.json                 # upstream import aliases + dev tooling
        ├── src/index.ts                 # extension entry point
        ├── test/
        ├── docs/
        ├── LICENSE
        └── UPSTREAM.md
```

Root `pi.extensions` lists entry points explicitly. Pi loads each as its own
extension; helper files and tests are not loaded as extensions. Workspaces simplify
development commands. All manifests are private;
nothing needs publishing.

## Extensions

### opencode-editor (inactive)

Source retained at `extensions/opencode-editor.ts`, but not listed in the bundle
manifest. It does not load. To re-enable it, add that entry point to `pi.extensions`.

### pi-subagents

Personal copy of [`gotgenes/pi-packages/packages/pi-subagents`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents).
Provides `subagent`, `get_subagent_result`, and `steer_subagent`, plus
`/subagents:settings`, `/subagents:sessions`, and `/subagents:watch`.

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

Above-editor widget matches subagents' compact top-rule/identity/status layout.
`/todos` or `/todos:list` opens a searchable browser matching insights. Commands:
`/todos:add`, `/todos:update`, `/todos:remove`, `/todos:clear`, `/todos:settings`.
Settings layer global `todos.json` with project `.pi/todos.json`.

User additions never start/steer a turn. Changed state syncs to the next model
request by default; no auto-removal, auto-completion, or implicit subagent dispatch.
Multiple active tasks remain possible for parallel work. See
[usage/settings](extensions/pi-todo/README.md) and
[comparison/decision report](extensions/pi-todo/docs/comparison.md).

## Development

Runtime loading needs no build. Install development dependencies only for checks
and tests:

```bash
npm install --ignore-scripts
npm run check
npm test
npm run verify:bundle
```

`verify:bundle` checks root-package discovery and tool registration in temporary
settings, without model calls or changes to your Pi configuration.

These check/test commands cover every development workspace. Pi modules
are dev dependencies for testing and peer dependencies for runtime; Pi supplies its
own modules when loading extensions.

Optional public API declaration generation (not needed for extension loading):

```bash
npm run build:types
```

To work on one extension without other configured extensions:

```bash
pi --no-extensions -e ./extensions/pi-subagents/src/index.ts
```

### Add another extension

1. Add `extensions/<name>.ts`, or `extensions/<name>/index.ts` for multiple files.
2. Add its entry point to root `package.json` under `pi.extensions`.
3. Run `/reload` (or restart Pi). No reinstall needed for a local checkout.

Keep helper modules beside their entry point, not registered separately. Add
third-party runtime dependencies to the bundle's root `dependencies` so Git installs
can install them; for local installs run `npm install --ignore-scripts` yourself.
Nested manifests alone do not expose another extension through the root bundle.

## License

Vendored subagents code retains its upstream [MIT license](extensions/pi-subagents/LICENSE).
Vendored todo engine retains its upstream [MIT license](extensions/pi-todo/LICENSE).
