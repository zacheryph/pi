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
copies, or another subagents extension, alongside this bundle: duplicate tools and
commands can conflict.

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
    └── pi-subagents/
        ├── package.json                 # upstream import aliases + dev tooling
        ├── src/index.ts                 # extension entry point
        ├── test/
        ├── docs/
        ├── LICENSE
        └── UPSTREAM.md
```

Root `pi.extensions` lists entry points explicitly. Pi loads each as its own
extension; helper files and tests are not loaded as extensions. The npm workspace
exists only to make development commands convenient. Both manifests are private;
nothing needs publishing.

## Extensions

### opencode-editor (inactive)

Source retained at `extensions/opencode-editor.ts`, but not listed in the bundle
manifest. It does not load. To re-enable it, add that entry point to `pi.extensions`.

### pi-subagents

Personal copy of [`gotgenes/pi-packages/packages/pi-subagents`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents).
Provides `subagent`, `get_subagent_result`, and `steer_subagent`, plus
`/subagents:settings` and `/subagents:sessions`.

Custom agents are read from `.pi/agents/<name>.md` in the project where Pi runs, or
`~/.pi/agent/agents/<name>.md`; they are not definitions inside this bundle.
See [upstream README](extensions/pi-subagents/README.md),
[configuration](extensions/pi-subagents/docs/configuration.md), and
[provenance/local changes](extensions/pi-subagents/UPSTREAM.md).

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

These check/test commands target the vendored subagents implementation. Pi modules
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
