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

`/dashboard` shows the URL and opens it in your browser.

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
The socket lives in a `0700` directory. The page is read-only: it shows
directories, session names, model names and dialog titles, but no transcript
content.

## Planned

Detail page (todos, stash index, subagents, usage, blackhole counts), a Focus
button that jumps to the session's cmux surface, then stash previews and
notifications. See the [plan](docs/plan.md).

## Development

From the repository root:

```bash
npm install --ignore-scripts
npm run check --workspace=pi-dashboard
npm test --workspace=pi-dashboard
```
