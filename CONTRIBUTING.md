# Working on this repository

Pi loads the TypeScript source directly: there is no build step and nothing is
published. Install development dependencies only for checks and tests.

```bash
npm install --ignore-scripts
npm run check          # formatting, lint, type checks
npm test               # every workspace
npm run verify:bundle  # what Pi discovers, and which way packages depend
```

`npm run fix` formats, applies safe lint fixes and formats again. Run one
workspace with `npm run test:workspace -- pi-todo` (a name or directory), or
watch it with `npm run test:watch -- pi-todo`. To try one extension alone:

```bash
pi --no-extensions -e ./extensions/pi-subagent/src/index.ts
```

Agent instructions for this repository are in [AGENTS.md](AGENTS.md).

## Layout

```text
├── package.json          # bundle manifest (pi.extensions, pi.skills) + npm workspaces
├── extensions/<name>/    # one Pi extension per workspace: src/, test/, README.md
├── packages/<name>/      # shared libraries; never loaded by Pi on their own
├── skills/               # skills shipped in the bundle
├── bb-plugin/            # bb plugin for pi-bb: its own package and toolchain
├── test/                 # bundle scenario tests (development only)
├── docs/                 # images, bb notes, plans and roadmaps
├── scripts/              # bundle, CI, changelog and check scripts
└── .agents/skills/       # skills for working on this repository (not in the bundle)
```

The root `pi.extensions` lists each extension's entry point explicitly; Pi loads
each as its own extension, and helper files and tests are never loaded.
`pi.skills` loads `skills/` and any `skills/` directory an extension ships
(pi-subagent's `creating-agents`).

Every directory under `extensions/` and `packages/` is an npm workspace named
after it. TypeScript configuration, Vitest projects and the development commands
live at the root, and registering a workspace includes its source and tests.
`scripts/bundle-manifest.test.mjs` checks that every workspace is registered with
a supported test runner and that `pi.extensions` and `pi.skills` match what the
extensions declare.

Dependencies point one way: extensions import packages, never the reverse. No
package names an extension in its dependencies, `imports` or `exports` or
imports extension source, and the bb plugin and the standalone dashboard hub
reach the repository only through pi-surface. `npm run verify:bundle` checks
this (`scripts/package-boundary.mjs`).

### Imports

Each workspace's `package.json` maps `#src/*` and `#test/*` to its own modules,
and shared aliases such as `#ui`, `#surface`, `#work`, `#session-state`,
`#session-tree`, `#foundations/settings` and `#test-helpers` to workspace
packages. Those packages export TypeScript source; root `file:` dependencies
create the links for Git installs. TypeScript, Vitest, Node and Pi's loader all
use these manifests, so there are no TypeScript `paths`. Relative imports, when
needed, end in `.ts`.

Pi's own modules are dev dependencies for tests and `"*"` peer dependencies at
runtime: Pi supplies them when it loads an extension. A library's runtime
dependency goes in the root `dependencies`.

### Tooling

Oxfmt and Oxlint use one root configuration for every workspace and script.
Oxlint's type-aware rules use the native TypeScript implementation; TypeScript 7
runs the full type check, and `tsconfig.hub.json` checks the dashboard hub's
plain-Node syntax separately. Generated declarations, coverage and the lockfile
are not formatted. Tests may reference mock methods in assertions; unbound-method
checking stays on for runtime source.

Agents get the same rule from a guard: `scripts/tool-guard.mjs` blocks shell
commands that run or install Prettier, ESLint, Biome or dprint and names the
oxfmt or oxlint command to use. `.claude/settings.json` runs it as a Claude Code
PreToolUse hook and `.pi/extensions/tool-guard.ts` loads it into Pi once the
project is trusted; `npm test` covers it in `scripts/tool-guard.test.mjs`.

The root `npm run check` formats `bb-plugin/` but neither lints nor type-checks
it: run `npm run typecheck` and `npm test` inside `bb-plugin/`.

## Tests

| Kind              | Where                                                                | Use it for                                                                  |
| ----------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Unit tests        | `extensions/<name>/test/`, `packages/<name>/test/`                   | One extension or library, with a fake `ExtensionAPI` or a faux SDK session. |
| Bundle scenarios  | [`test/`](test/README.md)                                            | Behaviour that exists only when extensions run together.                    |
| Shared helpers    | [`packages/pi-test-helpers`](packages/pi-test-helpers/README.md)     | Temp dirs, themes, padding assertions, `fakePi`, `fauxSession`.             |
| Scripted model    | [`packages/pi-scripted-model`](packages/pi-scripted-model/README.md) | The whole bundle on a fake model: real tools, real subagents, no key.       |
| pi-job end to end | [`extensions/pi-job/e2e/`](extensions/pi-job/e2e/README.md)          | Real Pi over RPC with a real model; costs a cent a run.                     |

Reach for pi-test-helpers before writing a local helper; keep helpers only one
workspace needs in its own `test/`. Add a bundle scenario for new
cross-extension behaviour, asserting on tool runs and model requests, not
internals.

## CI

GitHub Actions ([`extensions.yml`](.github/workflows/extensions.yml)) runs one
repository-wide job (formatting, lint, types, scripts, registration) and a test
job per selected workspace, plus `verify:bundle` and the bundle scenarios
whenever any workspace is selected. Pull requests select the workspaces with
changes under their directory; changes to root manifests, lockfiles, `.nvmrc`,
shared TypeScript or Oxc settings, workflows or scripts select all of them.
Pushes to `main` test everything. Matrix selection is tested by
`node --test scripts/select-test-extensions.test.mjs`. CI reads its Node.js
version from `.nvmrc`.

## Screenshots

README images are real Pi sessions on the scripted model, rendered to PNG:

```bash
node .agents/skills/tui-screenshot/scripts/docs-images.mjs            # all of docs/images/
node .agents/skills/tui-screenshot/scripts/docs-images.mjs todo-browser  # one
```

Each image's scenario is in
[`.agents/skills/tui-screenshot/scenarios/docs/`](.agents/skills/tui-screenshot/scenarios/docs/).
The [`tui-screenshot`](.agents/skills/tui-screenshot/SKILL.md) skill covers
one-off terminal shots and [`bb-screenshot`](.agents/skills/bb-screenshot/SKILL.md)
the bb integration (`docs/images/bb/`).

## Adding an extension

Use the [`new-extension`](.agents/skills/new-extension/SKILL.md) skill: its script
scaffolds the workspace and registers it. To bring in a third-party extension,
use [`import-extension`](.agents/skills/import-extension/SKILL.md): its first
commit is a verbatim copy of upstream, verified by tree hash, and the
changelog's **Initial import** entry records where it came from. Either way, add
a row to the root README's extension table and write the extension's README the
way the others are written (see [AGENTS.md](AGENTS.md#readmes)). To show an
extension's state in the dashboard and bb, use the
[`surface-view`](.agents/skills/surface-view/SKILL.md) skill.

## Changelogs

The [Weekly changelogs workflow](.github/workflows/changelogs.yml) runs every
Monday at 09:17 UTC (or with **Run workflow**) and opens or updates one PR on
`automation/weekly-changelogs` with a `CHANGELOG.md` for every extension and
package workspace. No new entries means no PR. Feature and fix PRs leave
changelogs alone; write descriptive commit subjects instead.

Each entry is one bullet: the UTC commit date, the commit subject, and a link to
the merged PR that introduced it (a commit link for direct commits). Any change
inside a workspace counts, except its `CHANGELOG.md`; root-only changes are not
attributed to workspaces. Merge wrapper commits are left out.

Each changelog carries a hidden `changelog:through` checkpoint, so a run covers
everything since that commit, even after missed weeks or a manual edit. Keep the
checkpoint when correcting an entry. An open update PR is regenerated from the
default branch on each run. Logs without a checkpoint are rebuilt from full
history, following directory renames; hand-written entries are replaced, but
the **Initial import** entry is kept whole. To rebuild checkpointed logs on
purpose, run `node scripts/update-changelogs.mjs --rebuild` with
`GITHUB_REPOSITORY` and `GH_TOKEN` set, from a checkout of the default branch.
Invalid checkpoints or failed PR lookups stop generation without writing.

The workflow needs **Settings → Actions → General → Workflow permissions →
Allow GitHub Actions to create and approve pull requests**. It uses
`GITHUB_TOKEN`; GitHub may ask you to approve workflows on the generated PR
before its checks run.
