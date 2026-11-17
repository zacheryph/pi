# pi-bb

Shows this bundle's session state (todos, subagents, stash, Git, open
questions, activity and usage) in bb's UI through the `pi-surface` bb plugin in
[`bb-plugin/`](../../bb-plugin/README.md).

bb runs Pi as `pi --mode rpc` and drops `setWidget`, `setStatus` and `notify`;
`ctx.ui.custom()` returns `undefined` there. This extension is the bundle's own
channel past that: it collects every view registered on the session's bus
([`pi-surface`](../../packages/pi-surface/README.md)) into one complete
`DeliverySnapshot` and sends it to the plugin, which draws it in bb's slots.
The session's core state (status, model, context, activity, usage) is the
`system.session` view of [`pi-system-insights`](../pi-system-insights/README.md);
this extension observes nothing itself and keeps no copy of any extension's
state. See [bb's UI slots](../../docs/bb/ui-slots.md) for what appears where.

Commands: `/bb` reports whether this session is connected. Outside the terminal
the answer is a displayed message kept out of the model's context, because bb
drops `notify`.

## When it runs

All of these must hold, checked on every `session_start`:

- Pi runs in RPC mode (`ctx.mode === "rpc"`).
- `BB_THREAD_ID` is set (bb's Pi provider sets it for every thread).
- `PI_BB_SURFACE_URL` and `PI_BB_SURFACE_TOKEN` are set. The plugin contributes
  both to every Pi thread with `bb.providers.experimental_contributeEnv("pi", …)`,
  so they exist only while the plugin is installed and enabled.
- No other session in this process holds the connection. Subagent children
  load the extension again in the same process (in print mode); the first
  RPC session claims a process-global slot and releases it on
  `session_shutdown`, so `/new`, `/resume` and `/reload` reconnect.

Otherwise it opens no socket and starts no timer. It never starts, connects to
or reports to the dashboard hub.

## Transport and authentication

One WebSocket per Pi process to the plugin's route
`/api/v1/plugins/pi-surface/http/session`, using Node's global `WebSocket` (no
dependency). The plugin hands the Pi process the route as
`{ serverPath }`, which bb's host expands against its `BB_SERVER_URL`
(`http://127.0.0.1:38886/...` on a local install); the extension switches the
scheme to `ws:`/`wss:`.

The route uses bb's `auth: "none"` mode and checks its own credential: the
first message must be a `hello` carrying `BB_THREAD_ID` and
`PI_BB_SURFACE_TOKEN`, which is an HMAC-SHA256 of the thread id under a random
secret the plugin keeps in its storage. A token therefore speaks for one thread
only. bb's per-plugin token (`auth: "token"`) is not used because a plugin
cannot read its own token to hand it out. Note that bb shows contributed
environment values in the thread's `provider.env-resolved` events.

Messages are JSON, one per WebSocket text frame
([`src/protocol.ts`](src/protocol.ts)), protocol version 3:

| Direction    | Message                                        | When                                  |
| ------------ | ---------------------------------------------- | ------------------------------------- |
| Pi to plugin | `hello { version, threadId, token, snapshot }` | First, on every connect               |
| Plugin to Pi | `welcome { version }`                          | The plugin accepted the hello         |
| Pi to plugin | `update { snapshot }`                          | After a burst of view changes, 250 ms |
| Pi to plugin | `bye { reason: "quit" \| "replace" }`          | `session_shutdown`                    |
| Plugin to Pi | `request { id, request: { action, args? } }`   | An action from bb's UI                |
| Pi to plugin | `result { id, ok, value? , error? }`           | Answer to one request                 |

Each snapshot is complete: pi-surface's `collectDelivery` reads every view
on the session's bus (`batchViews` coalesces the views' change announcements),
with the Pi process id as its identity, and the plugin replaces the previous
one with it. It fits the plugin's 2 MiB message limit in UTF-8 bytes, hello
framing included; the largest models are left out as error entries until it
does, and `/bb` reports a snapshot that cannot be sent at all. A request runs
an action on the session's bus (an explorer's `loadDetail`, a form's `submit`)
and the result goes back on the socket that asked, never to a replacement;
errors are cut to 500 characters. Malformed requests are dropped.

While the plugin has welcomed the session, the extension advertises itself as
a form consumer (pi-surface's `advertiseFormConsumer`), so pi-ask shows its
questionnaires as the `ask.questions` form, which bb raises as a pending
interaction, instead of Pi's own dialogs. The advertisement is withdrawn when
the connection closes or is refused and on `session_shutdown`; pi-ask then
hands an open questionnaire back to Pi's dialogs.

The socket reconnects with exponential backoff (0.5 s up to 30 s, timers
unref'd). Close codes 4400 (another protocol version), 4401 (bad token) and
4409 (a newer connection for the thread took over) stop retrying; `/bb` then
says to restart the thread after reinstalling the plugin. Pi's RPC mode exits
the process explicitly on shutdown, and the socket is closed in
`session_shutdown`, so the connection never keeps Pi running.

## bb's skills

bb puts every enabled plugin's skills into each thread's system prompt, and a
plugin cannot drop another's. In a bb thread (RPC mode with `BB_THREAD_ID`),
`before_agent_start` removes the skills bb injected (those under
`~/.bb/runtime/global-skills/`) except `inline-vis`, whose reply format the
model cannot guess. Set `PI_BB_SKILLS` to a comma-separated list of names to
replace the allowlist; an empty value allows none. Project, user and package
skills are never touched, and the removed skills stay installed in bb.

## bb's environment tool

bb gives every thread an `update_environment_directory` tool and appends a
paragraph telling the model to use it when asked to move the thread to another
checkout or worktree. No setting turns it off, so `before_agent_start` removes
the tool from the prompt's tool selection and the paragraph from the appended
text. Set `PI_BB_ENVIRONMENT_TOOL=1` to keep both. The thread can still be moved
from bb's UI.

## Configuration

The plugin decides the endpoint; the extension only reads the environment.
