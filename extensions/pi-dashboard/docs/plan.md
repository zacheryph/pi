# pi-dashboard: research and implementation plan

Status: proposal, nothing implemented yet. Wireframes are in the companion
artifact linked from the PR/session; ASCII versions are at the end of this file.

## Goal

A local web UI showing every running interactive Pi session:

- **Index:** all active sessions with directory, session name, and agent name
  (when started with `--agent`).
- **Detail:** directory, session name, model, thinking level, current status,
  context usage, blackhole stats, todos (status and details), stash items, and a
  button that opens/focuses the session's terminal (cmux today, adapter-based).
- **Lifecycle:** the web server starts automatically when a session starts and
  none is running, and exits when no sessions remain.

## Feasibility

| Data | Source | Verdict |
|---|---|---|
| Directory | `ctx.cwd` | Yes |
| Session name | `pi.getSessionName()`, `session_info_changed` (pi-tldr auto-names) | Yes |
| Session id/file | `ctx.sessionManager.getSessionId()` / `getSessionFile()` | Yes |
| Agent name | `pi-subagents:main-agent-profile` entry on the branch (`profile.name`) | Yes |
| Model | `ctx.model`, `model_select` | Yes |
| Thinking | `pi.getThinkingLevel()`, `thinking_level_select` | Yes |
| Status | Derived from `agent_start`, `turn_start`, `tool_execution_start/end`, `session_before_compact`/`session_compact`, `ui_prompt_start/end`, `agent_settled` | Yes: idle, working, running tool X, compacting, waiting on a prompt |
| Context usage | `ctx.getContextUsage()` (`tokens` is `null` just after compaction) | Yes |
| Tokens / cost | Sum `usage` on assistant entries in `getBranch()` | Yes |
| Todos | In-repo `pi-todo`; branch journal replay (`replayTodoSession`) | Yes; add a small publish hook in pi-todo instead of re-parsing |
| Subagents (bonus) | `getSubagentsService().listAgents()` on `globalThis` | Yes |
| Blackhole | No public API. Persists `om.observations.recorded`, `om.reflections.recorded`, `om.observations.dropped`, `om.folded` custom entries plus compaction entries | Partial: counts, last compaction, tokens since compaction are derivable. Live worker phase and gauges live in its runtime and are not reachable. Fragile across upstream versions; ask upstream for a `pi.events` snapshot |
| Stash | In-repo `pi-stash`. Index: `pi-personal:stash-index` custom entries on the branch (`put` + `checkpoint`), replayed by `replayStashIndex` / `currentEntries`. Content: hash-addressed blobs under `$PI_STASH_DIR` or `~/.pi/agent/stash/` | Yes: name, handle, bytes, lines, mime, description, source, creator session, age, version count, store usage vs `maxStoreBytes`. Content preview on demand only (see Security) |
| Focus session | cmux: capture `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID`, `CMUX_SOCKET_PATH` at startup, then `cmux select-workspace` + focus the surface/panel | Yes, with a spike to confirm verbs and socket access mode |

### Constraints found in research

- **Subagent children load extensions.** pi-subagents creates in-process child
  sessions that bind every bundle extension (per-package exclusion cannot
  exclude one extension of this bundle). The reporter must only register the
  main session: claim a process-global slot (`Symbol.for("pi-dashboard:reporter")`)
  on `session_start`, release it on `session_shutdown`, and skip when
  `ctx.mode !== "tui"`.
- **No long-lived resources in the factory.** Pi's extension contract says to
  start sockets/timers in `session_start` and release them idempotently in
  `session_shutdown`.
- **Runtime replacement.** `/new`, `/resume`, `/fork` and `/reload` fire
  `session_shutdown` (reason ≠ `quit`) then a fresh `session_start`. The hub
  needs a grace period so it neither exits nor drops the row.
- **cmux socket access.** cmux can restrict its socket to processes it spawned.
  A detached hub that outlives its parent Pi may be reparented and refused.
  Run focus commands inside the reporter (a real cmux descendant with the
  right env), routed from the hub over the reporter's connection.
- **cmux focus is user-affecting.** Only call focus verbs on an explicit click.
- **Stash content can hold secrets.** pi-stash stores plaintext tool output
  (env dumps, tokens in logs) with no redaction. Snapshots carry only index
  metadata; a preview is fetched on explicit click, through the reporter (which
  owns the `BlobStore` and its hash check), bounded to ~200 lines / 16 KB.
  The hub cannot read blobs itself anyway: `store.ts` imports from Pi.
- **No build step.** The repo loads TypeScript through Pi's jiti. The hub runs
  under plain Node 24 (outside Pi), so it must use erasable-only TypeScript
  (Node type stripping) or `.mjs`, and must not import Pi packages.

## Architecture

```text
pi (cmux surface A) ─ reporter ─┐
pi (cmux surface B) ─ reporter ─┼─ unix socket ─► hub ─ HTTP + SSE (127.0.0.1) ─► browser
pi (cmux surface C) ─ reporter ─┘  ~/.pi/agent/       ▲
                                   dashboard/hub.sock  └─ focus request routed back to reporter
```

### Reporter (Pi extension, `src/index.ts`)

- On `session_start` (main session only): connect to the hub socket. On
  `ENOENT`/`ECONNREFUSED`, spawn the hub
  (`spawn(process.execPath, [hubPath], { detached: true, stdio: "ignore" }).unref()`)
  and retry with backoff for ~2s.
- Send `hello` (pid, session id/file, cwd, name, agent, terminal locator, Pi
  version, start time) then `snapshot` messages: full on connect, debounced
  (~250ms) patches after. Do not forward streaming deltas.
- Collect data through **section providers**:
  `{ id, collect(ctx, pi): Json | undefined, triggers: EventName[] }`.
  Core, todos, stash, subagents, and blackhole are providers.
- Prefer publish hooks over re-parsing for in-repo extensions. pi-subagents
  already exposes a `globalThis` service; give pi-todo and pi-stash the same:
  a read-only accessor (`getTodoSnapshot()`, `getStashSnapshot()`) plus a
  `pi.events` change signal (`todos:changed`, `stash:changed`). Until then,
  the providers replay branch entries with the extensions' own exported
  replay functions (`replayTodoSession`, `replayStashIndex`), refreshing on
  `tool_execution_end` for `todo`/`stash_put`, `session_tree`, and
  `session_compact`.
- Handle hub commands: `focus` (via the terminal adapter) and `stash_preview`
  (bounded `stash_get`-style head or line range). Later phases can add
  abort/steer.
- `/dashboard` command: show the URL and open it (`open <url>` on macOS).
  Optional footer status via `ctx.ui.setStatus("dashboard", …)`.

### Hub (standalone Node process, `src/hub/server.ts`, not registered with Pi)

- Binding the unix socket is the startup mutex. On `EADDRINUSE`, probe the
  socket: live hub means exit; dead socket means unlink and bind.
- One reporter connection = one live session. A crash closes the socket, so no
  pid files or heartbeats are needed (an optional ping can catch hung processes).
- When the connection count reaches zero, start a ~15s grace timer (covers
  `/reload`, `/new`, quick restarts), then close, unlink the socket, and exit.
- HTTP on `127.0.0.1:<port>` (default 7317, configurable in
  `~/.pi/agent/dashboard.json`):
  - `GET /` static page (vanilla JS, no build)
  - `GET /api/sessions`, `GET /api/sessions/:id`
  - `GET /events` SSE: `session-added`, `session-updated`, `session-removed`
  - `POST /api/sessions/:id/focus`
  - `POST /api/sessions/:id/stash/:name/preview` (POST so the token check applies)
- Security: loopback only, `Host` header check (DNS rebinding), per-hub token
  required on POST with `Origin` check, socket in a `0700` directory. This
  matters more now that stash previews can expose tool output.

### Terminal adapters

```ts
interface TerminalAdapter {
  id: string;                                   // "cmux"
  detect(env: NodeJS.ProcessEnv): TerminalLocator | undefined;
  focus(locator: TerminalLocator): Promise<{ ok: boolean; error?: string }>;
  describe(locator: TerminalLocator): string;    // "cmux · workspace 2 · surface 5"
}
```

The first adapter whose `detect` matches wins. cmux detects on
`CMUX_SURFACE_ID`; focus runs `cmux select-workspace --workspace <id>` then the
surface/panel focus verb (confirm the exact verb with `cmux --help` during the
spike; docs list both `focus-surface` and `focus-panel`), and raises the app.
tmux, Ghostty, or iTerm adapters can follow without touching the hub.

## Phases

0. **Spike (½ day).** On the Mac: confirm the cmux focus verbs and the socket
   access mode from a process spawned by Pi; confirm Node 24 runs the hub `.ts`
   via `process.execPath`.
1. **MVP.** Hub lifecycle (spawn, socket mutex, grace shutdown), reporter core
   fields (cwd, name, agent, model, thinking, status, context), index page
   with live SSE updates, `/dashboard`. Tests: hub lifecycle in a temp dir,
   two concurrent spawns, reporter snapshot builder, main-session detection.
2. **Detail view and focus.** Todos and stash index (with publish hooks in
   pi-todo and pi-stash), subagents, tokens/cost, blackhole stats, cmux focus
   button.
3. **Previews and polish.** Stash content preview on click, todo activity
   timelines, recent activity (last tool calls), grouping/filtering by
   directory, browser notifications when a session waits on you, store usage
   warning when over `maxStoreBytes`.
4. **Actions (opt-in).** Abort, steer/send message, compact. Off by default.

## Open questions

- Stash scope: current branch only (what `stash_list` shows), or also handles
  subagents stored in their own sessions? (Proposed: current branch only.)
- Fixed port (bookmarkable) or random port with `/dashboard` as the only way in?
- Should `pi -p` print-mode runs appear? (Proposed: no.)
- Which wireframe layout (A table + drawer, B card grid, C split view)?

## ASCII wireframes

### A. Table + drawer

```text
┌ pi dashboard ───────────────────────────────── 4 sessions · ● live ┐
│ Filter [________]   Group: none ▾                                   │
│ STATUS     SESSION            AGENT         DIRECTORY        CTX    │
│ ● working  fix-auth-retry     orchestrator  ~/src/api        62%    │
│ ◐ waiting  dashboard-plan     —             ~/src/pi         31%    │
│ ○ idle     release-notes      —             ~/src/site        8%    │
│ ⠋ compact  vendor-jobs        —             ~/src/pi         91%    │
└─────────────────────────────────────────────────────────────────────┘
                     click a row → right drawer with detail sections
```

### B. Card grid

```text
┌──────────────────────────┐ ┌──────────────────────────┐
│ ● fix-auth-retry         │ │ ◐ dashboard-plan         │
│ orchestrator · ~/src/api │ │ ~/src/pi                 │
│ opus-5.5 · high          │ │ sonnet-5.5 · medium      │
│ ctx ██████░░░░ 62%       │ │ ctx ███░░░░░░░ 31%       │
│ todos 3/7 · 2 subagents  │ │ waiting: confirm dialog  │
│ [Focus]                  │ │ [Focus]                  │
└──────────────────────────┘ └──────────────────────────┘
```

### C. Split view

```text
┌ Sessions ─────────────┬ fix-auth-retry ─────────────────── [Focus] ┐
│ ~/src/api             │ ~/src/api · orchestrator                    │
│  ● fix-auth-retry  ◀  │ Model opus-5.5 · Thinking high · ● working  │
│ ~/src/pi              │ Context ██████░░░░ 124k / 200k (62%)        │
│  ◐ dashboard-plan     │ ┌ Todos 3/7 ┐ ┌ Blackhole ┐ ┌ Stash 3 ┐     │
│  ⠋ vendor-jobs        │ │ …         │ │ …         │ │ …       │     │
│ ~/src/site            │ └───────────┘ └───────────┘ └─────────┘     │
│  ○ release-notes      │ Subagents · Recent activity                 │
└───────────────────────┴─────────────────────────────────────────────┘
```
