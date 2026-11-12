# pi-test-helpers

Test helpers shared by every workspace in this repository: temp directories,
polling, themes, render assertions, a fake `ExtensionAPI`, and real Pi sessions
on an offline faux model. Development only: no extension imports it, and it is
not in the bundle manifest. Import the barrel through the workspace alias:

```ts
import { fakePi, tempDir, waitFor } from "#test-helpers";
```

The barrel evaluates all helper modules, including their Pi SDK and Vitest
imports. Importing it does not create a session, register teardown hooks or
clear global state. Modules marked _vitest_ use Vitest spies or assertions;
the common helpers also work under `node:test` (pi-job). Package-internal
imports stay direct so they do not cycle through the barrel.

## Cleanup (`src/cleanup.ts`)

Helpers that create something take a `Defer`: where to register its teardown.
Pass vitest's `onTestFinished` (it works in tests, helpers and `beforeEach`) or a
`node:test` context `t`. Teardowns run when the test ends, newest first, so no
file needs its own `afterEach` list of cleanups.

## Modules

| Module            | Exports                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `temp.ts`         | `tempDir(cleanup, prefix?)`; `writeFiles(root, files)`, objects written as JSON; `settingsDirs(cleanup, filename)`, an agent dir and a project for layered config files |
| `wait.ts`         | `waitFor(check, { timeout, interval, what })` returns the first truthy value; `sleep`, `tick`, `flushMicrotasks`                                                        |
| `theme.ts`        | `plainTheme`, `ansiTheme` (real SGR codes), `markupTheme` (`[color:text]`, `**bold**`), `stripAnsi` (colors only: leaked controls stay visible), `plainLines`           |
| `render.ts`       | _vitest_. `expectPadded(row, width)` (the AGENTS.md spacing rule), `expectBounded(lines, width, height?)`, `NARROW_WIDTHS`, `WIDE_TEXT`                                 |
| `globals.ts`      | `slots`, `clearSlots(...keys)`, `withSlot(key, value, run)`, `resetSessionTree()`                                                                                       |
| `fake-pi.ts`      | _vitest_. `fakePi(extra?)`: spies for `on`, `registerTool`, `registerCommand`, `appendEntry`, `sendMessage`, a working `events` bus; `emit`, `runTool`, `runCommand`    |
| `ui.ts`           | _vitest_. `fakeCustomUi({ theme, tui, awaitDone })`: a `ui.custom` spy that mounts each component; `fakeTui(rows, columns)`, `keybindings()`                            |
| `faux-session.ts` | `fauxSession(options)`, `fauxRuntime`, `toolCall`, `toolResults`, `messageText`, `loadResources`                                                                        |

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

## Real sessions on a faux model

`fauxSession` loads only the given inline extensions, creates an `AgentSession`
on pi-ai's faux provider with compaction and retry off, and binds it as print
mode does. Everything is offline and disposed when the test ends.

```ts
const h = await fauxSession({
  cleanup: onTestFinished,
  extensions: [(pi) => myExtension(pi, deps)],
  tools: ["my_tool"],
  responses: [toolCall("my_tool", { query: "x" }), fauxAssistantMessage("done")],
});
await h.session.prompt("go");
expect(h.errors).toEqual([]);
const [result] = toolResults(h.sessionManager, "my_tool");
expect(JSON.stringify(h.requests[1])).toContain("my_tool");
```

`requests` holds each provider request (system prompt, messages, tools) in
order; clear it with `requests.length = 0`. Options cover the working directory,
provider and models, an existing session manager (resume), session settings,
loader and session overrides, and extension bindings.

`loadResources(cleanup, { packages, extensions })` loads package directories
and extension files through Pi's real loader and returns its extensions result,
to prove entry points import without a build.

For behavior across the whole bundle and real subagents, use
[pi-scripted-model](../pi-scripted-model/README.md) instead.
