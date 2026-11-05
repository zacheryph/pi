# pi-scripted-model

A scripted fake model, and an in-process harness that runs this repository's
whole bundle against it. Tests drive real tools, real extensions and real
subagents with no API key, no network and no cost, and get the same result on
every run. The tui-screenshot skill uses the same scenarios for pictures of the TUI.

Development only: it is not in the bundle manifest, and `verify:bundle` fails if
it ever is. Import it by relative path, like the other packages.

## Scenarios (`src/scenario.ts`)

A scenario is a Pi extension that registers the `pi-scripted` provider. Its
`scripted-model` plays back a script instead of calling an API:

```ts
import { defineScenario, startAgent, text, tool, HOLD } from "../src/scenario.ts";

const scenario = defineScenario({
  replies: [
    // The reply to the first user turn: one entry per model response.
    [
      [text("Planning."), tool("todo_upsert", { tasks: [{ key: "a", subject: "A" }] })],
      [
        startAgent({
          type: "general-purpose",
          description: "Do A",
          prompt: "Do task A.", // identifies the child, so keep it unique
          steps: [[tool("read", { path: "a.txt" })], "A is done."],
          options: { foreground: true },
        }),
      ],
      "Done.", // a string ends the turn
    ],
    [HOLD], // the second turn stays open until aborted
  ],
});
```

- A list of blocks is one assistant message. Pi runs its tool calls for real and
  then asks for the next step. A string ends the turn. A turn with no steps left
  ends quietly.
- Replies are chosen from the transcript, never from counters, so one script
  answers the main session and every subagent. A child is matched by its
  `prompt`; when its steps run out it holds, still running.
- User turns include the follow-ups Pi starts on its own, such as a background
  subagent's completion notice. Context an extension adds mid-turn (pi-todo's
  task list after a tool result, for example) does not start a turn.
- `scripted-haiku` answers pi-tldr with the scenario's `title`.
- A scenario registers nothing unless `PI_SCRIPTED_MODEL=1` is set, so a stray
  `-e` cannot put a fake model into a real session.

## Harness (`src/harness.ts`)

```ts
import { startSession } from "../../../packages/pi-scripted-model/src/harness.ts";

const pi = await startSession({ scenario });
try {
  await pi.prompt("Plan it"); // resolves when the session is idle
  const upsert = pi.toolRuns().find((run) => run.name === "todo_upsert");
  expect(upsert?.isError).toBe(false);
} finally {
  await pi.dispose();
}
```

`startSession` loads the root package as a personal install would (every
extension and skill in the manifest), adds the scenario, selects the scripted
model and binds the session as Pi's print mode does.

| Option       | Default        | Effect                                                        |
| ------------ | -------------- | ------------------------------------------------------------- |
| `scenario`   | required       | The model, from `defineScenario`.                             |
| `cwd`        | fresh temp dir | Working directory; tools such as `read` and `bash` run here.  |
| `agentFiles` |                | Files for the agent directory, e.g. `{ "todo.json": {...} }`. |
| `bundle`     | `true`         | `false` loads only the scenario.                              |
| `mode`       | `"print"`      | The extension mode extensions see.                            |

The result exposes `session` (Pi's `AgentSession`), `prompt`, `toolRuns()`
(each call with its arguments, result text, `isError` and `details`),
`entries(customType?)`, every emitted event in `events`, `extensionErrors`, and
`dispose()`.

Isolation: HOME, the agent directory (with its `settings.json`), TMPDIR and the
default `cwd` are throwaway directories removed by `dispose`. While a session is
open, credential-like environment variables (API keys, tokens, cloud and GitHub
credentials) are removed, and `startSession` throws if any model other than the
scripted ones is available, so a test cannot reach a real provider. The
environment is restored on `dispose`. Because it is process-wide, only one
session may be open per process; vitest runs each test file in its own worker.

`test/harness.test.ts` shows end-to-end tests across extensions: a foreground
subagent running its own script, and a todo handed to a subagent that completes
it in the parent's list. CI runs this package whenever any extension changes.
