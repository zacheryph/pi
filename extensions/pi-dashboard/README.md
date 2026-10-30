# pi-dashboard

A local web page listing every running interactive Pi session, grouped by
working directory, with live status.

```text
http://127.0.0.1:7317/
```

Each card shows the session name (or `untitled …<id>`), the `--agent` profile
when one is active, model and thinking level, context usage, and status:
`idle`, `working`, `tool: <name>`, `compacting`, or `waiting` when Pi is
blocked on a dialog. Waiting sessions sort first and get a highlighted edge.

Cards also count todos (`todos <done>/<total>`, unreviewed messages as `N
new`), running subagents and stash entries. Click a card for its detail page
(`#<pid>`):

- **Header**: directory, agent, session id, pid, uptime, and **Focus**.
- **Strip**: model and provider, thinking level, status and how long it has
  held, context usage, session cost.
- **Todos**: every task with status, blocked state and unreviewed messages;
  expand one for its description, prerequisites and its full status and
  message history (fetched when you expand it).
- **Subagents**: agents seen since the session's runtime loaded, with state,
  duration, tool uses, tokens and the latest progress note or error.
- **Blackhole**: observations kept of recorded (and their tokens), dropped,
  reflections, compactions and the last one. Without pi-blackhole entries the
  panel shows compactions only.
- **Stash**: this branch's entries with size, lines, source, whether this
  session or a subagent stored them, age, versions and handle, plus the shared
  store's size against its cap (with a warning when over). **Preview** opens
  the first 200 lines / 16 KB of an entry in an overlay headed by its name,
  handle, description and facts; Esc, the × button or a click outside closes it.
- **Recent activity**: the last 12 tool calls with duration, failures, and
  what they touched: a file tool's path, or a bash command's first line.
- **Usage**: input, output and cache tokens and cost for the whole session
  file, matching `/session`.

The index has a filter box (every word must match the name, directory, agent,
model or status) and a **Notifications** toggle. With notifications on, the
browser notifies you when a session starts waiting on a dialog, or finishes its
work and goes idle, while the dashboard tab is open but not focused. Clicking a
notification opens that session. The filter and toggle are remembered per
browser.

`/dashboard` shows the URL and opens it in your browser.

## Focus

In cmux, **Focus** runs `cmux focus-panel --panel "$CMUX_PANEL_ID"`, which
selects the session's workspace, surface and tab, then `open -b
"$CMUX_BUNDLE_ID"` on macOS to bring cmux in front of the browser. It runs
inside the Pi process (the hub forwards the click over the session's socket),
because the cmux CLI authenticates with the socket capability cmux put in that
process's environment. `CMUX_BUNDLED_CLI_PATH` is preferred over `cmux` on
`PATH`. Sessions outside cmux show no Focus button; other terminals can be
added as adapters in `src/terminal.ts`.

## Data sources

| Section | Source |
|---|---|
| Todos | `pi-todo:snapshot` on the session's `pi.events` bus (history from the same event) |
| Stash | `pi-stash:snapshot` on the session's `pi.events` bus; previews through pi-stash's `pi-stash:preview` request on the same bus |
| Subagents | pi-subagents' `subagents:*` lifecycle events on the same bus. Its `globalThis` service is not used: subagent children load the extension in-process and replace it. Agents started before a `/reload` are not listed. |
| Blackhole | `om.observations.*` and `om.reflections.recorded` entries pi-blackhole saves on the branch (no public API; unknown shapes are skipped) |
| Usage | Usage on every entry in the session file, as Pi's `/session` sums it |
| Activity | Pi's `tool_execution_start` / `_end` for top-level calls (codemode's nested calls are left out) |

Payloads are parsed defensively and bounded before they reach the hub. Stash
content and task history are never part of the live session list; they are
fetched only when you open them, and returned only to the page that asked.

## How it works

- Every interactive (TUI) Pi session runs a small reporter. Print, JSON and RPC
  runs are not shown, and neither are subagent children, which run in print
  mode. One process reports at most one session.
- The reporter connects to a hub over a unix socket at
  `~/.pi/agent/dashboard/hub.sock`. If nothing answers, it starts the hub as a
  detached Node process (output in `~/.pi/agent/dashboard/hub.log`). Binding the
  socket is the lock, so concurrent sessions start exactly one hub.
- An open connection means a live session: a session that quits or crashes
  leaves the page at once. `/new`, `/resume`, `/fork` and `/reload` keep the card
  while the runtime restarts.
- The hub exits 15 seconds after the last session disconnects and starts again
  with the next session.
- Updates are pushed to the page with server-sent events, coalesced to at most
  one every 250 ms per session. Streaming tokens are never sent.

macOS and Linux only (the hub uses a unix socket). The hub runs outside Pi
under plain Node, which strips TypeScript types. It uses Pi's own Node binary;
when Pi is a compiled (Bun) build it falls back to `node` on `PATH` (Node 22.18
or newer).

## Configuration

`~/.pi/agent/dashboard.json` (global only, since one hub serves every project):

```json
{ "port": 7317, "node": "/opt/homebrew/bin/node" }
```

- `port`: loopback HTTP port. If it is taken, the hub keeps retrying and
  `/dashboard` says so.
- `node`: Node binary for the hub; defaults to Pi's runtime.

A port change takes effect when the hub next starts (after every session exits).

## Security

The hub listens on `127.0.0.1` only and rejects requests whose `Host` header is
not `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS-rebinding pages.
The socket lives in a `0700` directory. The live session list shows
directories, session names, model names, dialog titles, task text, subagent
descriptions, stash entry names and descriptions, and recent tool calls
(including the first line of bash commands, clipped to 80 characters). It
carries no transcript or stash content.

Requests the page makes of a session (`POST /api/sessions/<id>/focus`,
`/stash/<name>/preview`, `/todos/<key>/history`) require a random per-hub
token that is embedded in the page and sent as `X-Dashboard-Token`, and an
`Origin` of the dashboard itself when the browser sends one. Other sites cannot
read the page to learn the token. The hub accepts an answer only from the
connection of the session it asked, and returns it to that request alone.
Stash previews are read by pi-stash itself (hash-checked, this branch's entries
only, bare names only) and capped at 200 lines / 16 KB. Stashed text can hold
secrets from tool output; a preview shows what is stored.

## Planned

Opt-in actions (abort, steer, compact). See the [plan](docs/plan.md).

## Development

From the repository root:

```bash
npm install --ignore-scripts
npm run check --workspace=pi-dashboard
npm test --workspace=pi-dashboard
```
