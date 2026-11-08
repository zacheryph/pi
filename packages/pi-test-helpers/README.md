# pi-test-helpers

Test helpers shared by every workspace in this repository: temp directories,
polling, themes, render assertions, a fake `ExtensionAPI`, and real Pi sessions
on an offline faux model. Development only: no extension imports it, and it is
not in the bundle manifest. Import a module by relative path, like the other
packages:

```ts
import { tempDir } from "../../../packages/pi-test-helpers/src/temp.ts";
```

Each module stands alone, so a pure unit test does not load Pi's SDK. Modules
marked _vitest_ import vitest; the rest also work under `node:test` (pi-job).

## Cleanup (`src/cleanup.ts`)

Helpers that create something take a `Defer`: where to register its teardown.
Pass vitest's `onTestFinished` (it works in tests, helpers and `beforeEach`) or a
`node:test` context `t`. Teardowns run when the test ends, newest first, so no
file needs its own `afterEach` list of cleanups.

## Modules

| Module       | Exports                                                                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `temp.ts`    | `tempDir(cleanup, prefix?)`; `writeFiles(root, files)`, objects written as JSON; `settingsDirs(cleanup, filename)`, an agent dir and a project for layered config files |
| `wait.ts`    | `waitFor(check, { timeout, interval, what })` returns the first truthy value; `sleep`, `tick`, `flushMicrotasks`                                                        |
| `theme.ts`   | `plainTheme`, `ansiTheme` (real SGR codes), `markupTheme` (`[color:text]`, `**bold**`), `stripAnsi` (colors only: leaked controls stay visible), `plainLines`           |
| `render.ts`  | _vitest_. `expectPadded(row, width)` (the AGENTS.md spacing rule), `expectBounded(lines, width, height?)`, `NARROW_WIDTHS`, `WIDE_TEXT`                                 |
| `globals.ts` | `slots`, `clearSlots(...keys)`, `withSlot(key, value, run)`, `resetSessionTree()`                                                                                       |
| `fake-pi.ts` | _vitest_. `fakePi(extra?)`: spies for `on`, `registerTool`, `registerCommand`, `appendEntry`, `sendMessage`, a working `events` bus; `emit`, `runTool`, `runCommand`    |
| `ui.ts`      | _vitest_. `fakeCustomUi({ theme, tui, awaitDone })`: a `ui.custom` spy that mounts each component; `fakeTui(rows, columns)`, `keybindings()`                            |

## Unit tests of an extension factory

```ts
const h = fakePi({ getSessionName: () => "fix-auth" });
myExtension(h.api);
await h.emit("session_start", { reason: "startup" }, ctx);
const result = await h.runTool("my_tool", { query: "x" }, ctx);
expect(h.pi.registerCommand).toHaveBeenCalledWith("my:command", expect.anything());
```

`emit` runs every handler for the event in order, awaiting each, with
`{ type, ...payload }` as the event, and returns the last result. Pass members to
`fakePi` to add or replace them, such as an `appendEntry` that writes to a real
`SessionManager`.
