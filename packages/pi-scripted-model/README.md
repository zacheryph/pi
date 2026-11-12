# pi-scripted-model

A scripted fake model, and an in-process harness that runs this repository's
whole bundle against it. Tests drive real tools, real extensions and real
subagents with no API key, no network and no cost, and get the same result on
every run. The tui-screenshot skill uses the same scenarios for pictures of the TUI.

Development only: it is not in the bundle manifest, and `verify:bundle` fails if
it ever is. Import its modules through `#scripted-model/*` aliases.

## Scenarios (`src/scenario.ts`)

A scenario is a Pi extension that registers the `pi-scripted` provider. Its
`scripted-model` plays back a script instead of calling an API:

```ts
import { defineScenario, startAgent, text, tool, HOLD } from "#scripted-model/scenario";

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
        }),
      ],
      "Started.", // a string ends the turn
    ],
    // The agent's completion message starts the second turn.
    ["Noted."],
    [HOLD], // the third turn stays open until aborted
  ],
});
```

- A list of blocks is one assistant message. Pi runs its tool calls for real and
  then asks for the next step. A string ends the turn. A turn with no steps left
  ends quietly.
- Replies are chosen from the transcript, never from counters, so one script
  answers the main session and every subagent. A child is matched by its
  `prompt`. Its steps run in order across all its turns, so after an `ask` the
  answer `subagent_send` delivers gets the next step. When they run out it
  holds, still running.
- A step can be a function of the messages the model was sent, for arguments
  only known at run time, such as an agent ID or a worktree path:
  `(messages) => [tool("subagent_send", { agent_id: idFrom(messages), message: "blue" })]`.
- `prompts` maps an exact user prompt to the reply for the turn it starts,
  checked before `replies`. A compaction drops earlier turns from the context,
  which moves the positions `replies` counts, so script turns after one here.
- A compaction's summary request is answered with `summary` (default
  `"Scripted summary."`).
- User turns include the follow-ups Pi starts on its own, such as a background
  subagent's completion notice. Context an extension adds mid-turn (pi-todo's
  task list after a tool result, for example) does not start a turn.
- `scripted-haiku` answers pi-tldr with the scenario's `title`.
- A scenario registers nothing unless `PI_SCRIPTED_MODEL=1` is set, so a stray
  `-e` cannot put a fake model into a real session.

## Harness (`src/harness.ts`)

```ts
import { startSession } from "#scripted-model/harness";

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

| Option       | Default        | Effect                                                         |
| ------------ | -------------- | -------------------------------------------------------------- |
| `scenario`   | required       | The model, from `defineScenario`.                              |
| `cwd`        | fresh temp dir | Working directory; tools such as `read` and `bash` run here.   |
| `agentFiles` |                | Files for the agent directory, e.g. `{ "todo.json": {...} }`.  |
| `bundle`     | `true`         | `false` loads only the scenario.                               |
| `mode`       | `"print"`      | The extension mode extensions see.                             |
| `settings`   | see below      | Pi settings merged into the agent directory's `settings.json`. |

The session is saved to a file in the agent directory, as a real one is.
`settings` defaults to `{ compaction: { keepRecentTokens: 1 } }`, so a session
of a few short turns has something to compact.

The result exposes:

- `session`, Pi's current `AgentSession` (`resume` replaces it), and `prompt`.
- `toolRuns()`: each main-session call with its arguments, result text,
  `isError` and `details`. `collectToolRuns` builds the same list from any
  messages, such as a subagent's transcript.
- `requests()`: every main-session model request, oldest first and across
  resumes, with the messages sent after every extension's `context` handler ran.
  Context cards keep `role: "custom"` and their `customType` here (the provider
  sees them as user messages), so a test can count each kind.
- `compact()`: compact now, as `/compact` does.
- `resume()`: settle the session, emit `session_shutdown`, then reopen its file
  in a new session that starts with reason `"resume"`, as `/resume` does.
- `entries(customType?)`, every emitted event in `events`, `extensionErrors`,
  and `dispose()`, which ends the session with `session_shutdown` as quitting
  does.

Isolation: HOME, the agent directory (with its `settings.json`), TMPDIR and the
default `cwd` are throwaway directories removed by `dispose`. While a session is
open, credential-like environment variables (API keys, tokens, cloud and GitHub
credentials) are removed, and `startSession` throws if any model other than the
scripted ones is available, so a test cannot reach a real provider. The
environment is restored on `dispose`. Because it is process-wide, only one
session may be open per process; vitest runs each test file in its own worker.

`test/harness.test.ts` covers the harness itself, including a background
subagent running its own script and announcing its result in a completion
message. Scenarios for behaviour across extensions live in the root
[`test/`](../../test) workspace, which CI runs whenever any extension or
package changes.
