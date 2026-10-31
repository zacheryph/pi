---
name: new-extension
description: Create a new first-party Pi extension in this repository's bundle. Scaffolds extensions/<name>/ as an npm workspace, registers it in the root manifest, the bundle check and the README, and sets up tests that follow the repository's UI, session and CI conventions. Use when adding a new extension, a new tool or command that belongs in its own extension, or a new shared library under packages/. For copying a third-party extension, use vendor-extension instead.
---

# Add a new extension

Every extension is its own workspace under `extensions/<name>/`, loaded by Pi
through an explicit entry in the root `package.json`. Nothing is built or
published: Pi loads the TypeScript source directly. `extensions/pi-tldr/` is the
smallest complete example; copy its shape.

Names are `pi-<topic>` (lowercase, hyphenated). Before starting, check that no
existing extension already owns the tool or command you want; extend that one
instead when it does.

## 1. Scaffold the workspace

```text
extensions/<name>/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── src/index.ts          # default export: (pi: ExtensionAPI) => void
└── test/index.test.ts
```

`package.json`, matching the other first-party workspaces:

```json
{
  "name": "<name>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "<one line>",
  "keywords": ["pi-package", "pi-extension"],
  "files": ["src", "README.md"],
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*"
  },
  "engines": { "node": ">=24" },
  "scripts": { "check": "tsc --noEmit", "test": "vitest run", "test:watch": "vitest" },
  "devDependencies": {
    "@earendil-works/pi-ai": "1.4.0",
    "@earendil-works/pi-coding-agent": "1.4.0",
    "@earendil-works/pi-tui": "1.4.0",
    "@types/node": "^24.19.2",
    "typescript": "^6.0.3",
    "vitest": "^5.0.5"
  },
  "pi": { "extensions": ["./src/index.ts"] }
}
```

- Copy the Pi and tool versions from `extensions/pi-tldr/package.json` at the
  time you scaffold, not from this file, so the pins stay aligned.
- Add `typebox` (peer `*`, dev pinned like `extensions/pi-todo`) only if the
  extension registers tools with schemas. Drop `pi-tui` if it renders nothing.
- CI runs `check` and `test` for the workspace without `--if-present`; both
  scripts must exist.

`tsconfig.json` extends the shared strict base:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ root: import.meta.dirname, test: { include: ["test/**/*.test.ts"] } });
```

Import siblings by relative path. Use `#src/*` aliases only if
you also add the matching `imports` and `paths` entries, as `extensions/pi-todo`
does.

## 2. Register it

1. Root `package.json`: add `extensions/<name>` to `workspaces` and
   `./extensions/<name>/src/index.ts` to `pi.extensions`. Order in
   `pi.extensions` is load order; put an extension after anything it needs at
   `session_start`.
2. Run `npm install --ignore-scripts` to update `package-lock.json`. CI uses
   `npm ci`, so a stale lockfile fails every job.
3. `scripts/verify-bundle.mjs`: add each tool to the tools list and each command
   to the commands list it asserts. The script also fails on duplicate tool,
   command or flag names across the bundle.
4. Root `README.md`: add the directory to the layout tree and an `### <name>`
   section under Extensions: what it does, its tools and commands, its config
   files, and a link to `extensions/<name>/README.md`.

Runtime dependencies are rare here. If you need one, add it to the **root**
`dependencies`, since a Git install of the bundle installs only those.

## 3. Follow the runtime conventions

**Sessions.** Every subagent is a full in-process Pi session that loads every
bundle extension again. So:

- Keep all state in the factory's closure, never in module scope: a same-cwd
  child may share the parent's module instance.
- Rebuild state on `session_start` from `ctx.sessionManager.getBranch()` and
  persist with `pi.appendEntry`, so `/tree`, resume, reload and compaction work.
- Guard UI with `ctx.hasUI`; children have none.
- A captured `ctx` goes stale after reload. Re-read it from each event.
- To reach another session (parent or child), use
  `packages/pi-session-tree` (`provide`, `call`, `ancestors`) by relative path.
  Never put a bare object on `globalThis`.

**Talking to other extensions.** Publish state on the session's `pi.events` bus
as `<name>:<event>` (see `pi-todo:snapshot`, `pi-stash:snapshot`), with a
version field. pi-dashboard and others subscribe there.

**Configuration.** Global file `~/.pi/agent/<topic>.json` via `getAgentDir()`,
optional project override `.pi/<topic>.json`, sanitized field by field with
defaults for anything missing or invalid (see `extensions/pi-todo/src/config.ts`).
Never throw on a malformed file; warn and use defaults.

**Tools.** Clear `description` and `promptGuidelines`, bounded output (Pi caps
at 50 KB / 2,000 lines; stay well under), and `annotations.readOnlyHint` on
tools that only read, so pi-jobs can watch them.

**Terminal UI.** Follow `AGENTS.md`: at least one space of padding on both sides
of every body row, subtract padding before layout and truncation, blank rows
when the width cannot fit padding plus content. Fullscreen views use a centered
overlay; regular mode uses a custom screen (see `extensions/pi-system-insights`).

## 4. Test it

- `test/index.test.ts`: register the factory against a small fake `pi` that
  captures `on`, `registerTool` and `registerCommand`, and drive the handlers
  (see `extensions/pi-tldr/test/index.test.ts`).
- Rendering: test narrow widths, ANSI-colored text and wide Unicode, and assert
  the padding rules.
- Anything that persists or crosses sessions: one SDK test with Pi's real
  `DefaultResourceLoader`, `createAgentSession` and the faux provider (see
  `extensions/pi-stash/test/sdk.test.ts`). It runs offline.

## 5. Verify and open the PR

```bash
npm run check -w extensions/<name>
npm test -w extensions/<name>
npm run verify:bundle
node --test scripts/select-test-extensions.test.mjs
```

Then `/reload` in Pi to try it; a local checkout needs no reinstall. Commit with
`git -c commit.gpgsign=false commit`. In the PR, list the tools and commands
added and what `verify:bundle` now asserts.

## Shared libraries

Code that several extensions import goes in `packages/<name>/` instead: a
workspace with no `pi` manifest entry, so Pi never loads it as an extension.
Add it to `workspaces` only; extensions import it by relative path. CI re-tests
every workspace when a package changes. See `packages/pi-session-tree/`.
