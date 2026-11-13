# bb's Pi provider: launch, environment and hooks

How bb starts Pi, what it passes in, and the hooks that change the launch. Read
from the bb source, not from bb's user guide, which mentions none of the hooks.

- Source: [`get-bb/bb`](https://github.com/get-bb/bb), MIT,
  `plugins/provider-pi`, commit `63df380` (2026-11-12).
- Installed here: bb 0.49.0, plugin SDK 0.6.132, Pi 1.5.2.

Recheck against the source after a bb upgrade; nothing here is a stable API.

## Command line

One `pi` process per bb thread, restarted whenever bb resumes the thread or its
environment changes (`src/bridge/rpc-child.ts`, `src/bridge/rpc-session.ts`):

```text
<command> <extra args>
  --mode rpc
  --session <file> | --no-session
  --session-dir <dir>
  --extension <bb's injected extension>
  [--system-prompt <file>] [--append-system-prompt <file>]
  [--skill <path>]...
  [--provider <p> --model <id>]
  [--thinking <level>]
```

`<command>` is `pi` from `PATH` and `<extra args>` is empty unless the hooks
below are set. The model catalog is read by a second, short-lived process per
directory: `<command> <extra args> --mode rpc --no-session --extension …`,
then RPC `get_state` and `get_available_models`. That process loads your
installed extensions too, so:

- a model or virtual model an extension registers shows up in bb's model
  picker;
- an extension that fails to load breaks model listing for the provider
  (`bb provider models pi` prints Pi's error).

## Launch hooks

| Variable               | Value                   | Effect                        |
| ---------------------- | ----------------------- | ----------------------------- |
| `BB_PI_BRIDGE_COMMAND` | Executable name or path | Replaces `pi`                 |
| `BB_PI_BRIDGE_ARGS`    | JSON array of strings   | Prepended to every invocation |

Rules, from `resolvePiLaunch`:

- `BB_PI_BRIDGE_ARGS` is read only when `BB_PI_BRIDGE_COMMAND` is set. To add
  arguments to the normal binary, set the command to `pi` as well.
- The value must parse as a JSON array of strings; anything else throws and no
  Pi thread starts.
- The arguments go in front of every call the bridge makes: thread sessions,
  the model catalog probe, `--version` (the install check) and
  `update --self`. An argument Pi rejects in any of those breaks that call.

Where to set them: the provider declares both as `env.passthrough`, so a value
in the **host daemon's environment** reaches the bridge process. bb strips
every other inherited `BB_*` variable. They are read from the bridge's own
environment, not per thread, so they apply to every Pi thread on that host.
Whether `bb machine env set` feeds the daemon environment is not verified.

```sh
# Every Pi thread on this host starts as the orchestrate agent.
export BB_PI_BRIDGE_COMMAND=pi
export BB_PI_BRIDGE_ARGS='["--agent","orchestrate"]'
```

A wrapper script as the command is the flexible form: it can read a per-thread
variable (see below) and add arguments itself.

```sh
#!/bin/sh
# BB_PI_BRIDGE_COMMAND=/path/to/pi-wrapper
exec pi ${PI_MAIN_AGENT:+--agent "$PI_MAIN_AGENT"} "$@"
```

This repository does not depend on either hook. `pi-subagent` reads
`PI_MAIN_AGENT` itself (see [the plan](../plans/rpc-surfaces.md)), which works
per thread and needs no wrapper.

## Environment the Pi process receives

Built by `buildPiChildEnv` and `buildPiSessionParams`:

1. The bridge's own environment, sanitized.
2. `BB_THREAD_ID`, the bb thread id.
3. The thread's environment variables: machine variables
   (`bb machine env set NAME [--project <id>]`) and anything a bb plugin
   returns from `bb.providers.experimental_contributeEnv("pi", …)`. bb calls
   that resolver with `threadId`, `projectId` and `hostId` on every start,
   resume, fork and turn, so a plugin can set a variable per thread.
4. `PI_BB_TOOLS_FILE`, bb's own tool list.
5. `BB_PI_BRIDGE_CHANNEL` and `BB_PI_BRIDGE_CHANNEL_TOKEN`, which bb's injected
   extension deletes from `process.env` as it connects.

These are in the Pi process itself, so extensions read them from
`process.env`, not only the bash tool. A change to the thread's variables
restarts the Pi process on the next turn.

## What bb does with what Pi emits

| From Pi                                                                  | In bb                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Message, tool and compaction events                                      | Timeline rows, drawn by bb                                          |
| `ctx.ui.select`, `confirm`, `input`, `editor`                            | A `provider-pi/extension-ui` interaction that replaces the composer |
| `ctx.ui.notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` | Accepted and dropped                                                |
| `ctx.ui.custom()`                                                        | Never leaves Pi: returns `undefined` in RPC mode                    |
| Custom message with `display: true`                                      | A provider row in the timeline with its text                        |
| Custom message with `display: false`                                     | Not shown                                                           |

Consequences for an extension:

- Text a user must see goes through `pi.sendMessage({ display: true })`, not
  `notify`.
- Tool rows come from the tool's name, arguments and result text; `renderCall`
  and `renderResult` do not run.
- A dialog left open when the session closes is answered as cancelled.

## Provider facts

- Declares `permissionModes: ["full"]`, checkpoint forks, manual compaction, and
  no thread rename, archive or native user question.
- Reports no `sessionOptions` on its models, so bb's per-model option picker
  (`bb thread spawn --option`) has nothing to offer for Pi. See
  [provider size](pi-provider-size.md) for what adding one would cost.
- Reports `commands: { list: false }`, so bb's `/` menu does not list Pi's
  extension commands. Pi still runs one that arrives as a prompt; whether bb
  passes a typed `/todo` through unchanged is not verified.
