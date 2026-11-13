# pi-bb

Shows this bundle's session state (todos, subagents, stash, Git, open
questions, activity and usage) in bb's UI through the `pi-surface` bb plugin in
[`bb-plugin/`](../../bb-plugin/README.md).

bb runs Pi as `pi --mode rpc` and drops `setWidget`, `setStatus` and `notify`;
`ctx.ui.custom()` returns `undefined` there. This extension is the bundle's own
channel past that: it builds a `PresentationService` (from
[`pi-presentation`](../../packages/pi-presentation/README.md)) and sends the
session's full `SessionSnapshot` to the plugin, which draws it in bb's slots.
See [bb's UI slots](../../docs/bb/ui-slots.md) for what appears where.

Commands: `/bb` reports whether this session is connected. In RPC mode the
answer is a displayed message, because bb drops `notify`.

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
([`src/protocol.ts`](src/protocol.ts)):

| Direction    | Message                                        | When                                      |
| ------------ | ---------------------------------------------- | ----------------------------------------- |
| Pi to plugin | `hello { version, threadId, token, snapshot }` | First, on every connect                   |
| Pi to plugin | `update { snapshot }`                          | On change, coalesced over 250 ms          |
| Pi to plugin | `bye { reason: "quit" \| "replace" }`          | `session_shutdown`                        |
| Pi to plugin | `result { id, ok, data? , error? }`            | Answer to one request                     |
| Plugin to Pi | `request { id, request }`                      | `stash-preview`, `todo-history`, `answer` |

Requests go to `PresentationService.request()`; unknown ones are dropped. The
socket reconnects with exponential backoff (0.5 s up to 30 s, timers unref'd).
Close codes 4400 (unsupported version), 4401 (bad token) and 4409 (a newer
connection for the thread took over) stop retrying. Pi's RPC mode exits the
process explicitly on shutdown, and the socket is closed in
`session_shutdown`, so the connection never keeps Pi running.

## Configuration

None. The plugin decides the endpoint; the extension only reads the
environment.
