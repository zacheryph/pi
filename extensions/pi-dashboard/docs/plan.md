# pi-dashboard: research and implementation plan

Status: phase 1 (MVP) and the publish hooks implemented; phases 2–4 planned. Wireframes are in the
companion artifact linked from the PR/session; ASCII versions of the chosen
layout are at the end of this file. Usage docs: [README](../README.md).

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
| Blackhole | No public API. Persists `om.observations.recorded`, `om.reflections.recorded`, `om.observations.dropped`, `om.folded` custom entries plus compaction entries | Partial: counts, last compaction, tokens since compaction are derivable. Live worker phase and gauges live in its runtime and are not reachable. Fragile across upstream versions; parse defensively and hide the section on unknown shapes (upstream hook deferred) |
| Stash | In-repo `pi-stash`. Index: `pi-personal:stash-index` custom entries on the branch (`put` + `checkpoint`), replayed by `replayStashIndex` / `currentEntries`. Content: hash-addressed blobs under `$PI_STASH_DIR` or `~/.pi/agent/stash/` | Yes: name, handle, bytes, lines, mime, description, source, creator session, age, version count, store usage vs `maxStoreBytes`. Content preview on demand only (see Security) |
| Focus session | cmux: `cmux focus-panel --panel "$CMUX_PANEL_ID"`, then `open -b "$CMUX_BUNDLE_ID"` to raise the app | Yes, confirmed in the spike |

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
- Publish hooks, not re-parsing, for in-repo extensions (done in PR 2).
  pi-todo and pi-stash emit full, versioned snapshots on the session's
  `pi.events` bus (`pi-todo:snapshot`, `pi-stash:snapshot`) on session start,
  branch changes and every change; the dashboard caches the latest and parses
  it defensively. Not a `globalThis` accessor: subagent children load the same
  extensions in-process and would overwrite it, while each child gets its own
  event bus (`DefaultResourceLoader` creates one per session tree).
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
`CMUX_PANEL_ID` and focuses with:

```bash
cmux focus-panel --panel "$CMUX_PANEL_ID"   # selects the right workspace, surface and tab
open -b "$CMUX_BUNDLE_ID"                   # focus-panel does not raise cmux above the browser
```

tmux, Ghostty, or iTerm adapters can follow without touching the hub.

### Spike results (phase 0, done)

From a Pi session in cmux on the Mac:

- Env: `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID` (equal to `CMUX_PANEL_ID`),
  `CMUX_SOCKET_PATH`, `CMUX_BUNDLE_ID=com.cmuxterm.app`, plus a per-surface
  `CMUX_SOCKET_CAPABILITY` token. Running focus inside the reporter keeps that
  token in scope; a detached hub should not rely on it.
- Verbs: `focus-panel --panel <id> [--workspace <id>]`, `focus-pane`,
  `focus-window --window <id>`. `select-workspace` works and prints a notice
  that it is now `cmux workspace select`; use the new form (or `CMUX_QUIET=1`).
- `focus-panel --panel "$CMUX_PANEL_ID"` alone opens the right workspace,
  surface and tab, so no separate workspace select is needed. It does not bring
  cmux in front of a focused browser; macOS app activation is a separate step
  (`open -b "$CMUX_BUNDLE_ID"`).
- The installed `pi` is a Bun binary, so the reporter runs under Bun and the
  hub launcher takes the `node` on PATH fallback. Node v26.10.0 on PATH strips
  types (`node` in `~/.pi/agent/dashboard.json` overrides).

## Phases

0. **Spike (½ day, done; see above).** On the Mac: confirm the cmux focus verbs and the socket
   access mode from a process spawned by Pi; confirm Node 24 runs the hub `.ts`
   via `process.execPath`.
1. **MVP (implemented).** Hub lifecycle (spawn, socket mutex, grace shutdown), reporter core
   fields (cwd, name, agent, model, thinking, status, context), index page
   with live SSE updates, `/dashboard`. Tests: hub lifecycle in a temp dir,
   two concurrent spawns, reporter snapshot builder, main-session detection.
2. **Detail view and focus.** Todos and stash index (publish hooks landed in
   PR 2), subagents, tokens/cost, blackhole stats, cmux focus button.
3. **Previews and polish.** Stash content preview on click, todo activity
   timelines, recent activity (last tool calls), grouping/filtering by
   directory, browser notifications when a session waits on you, store usage
   warning when over `maxStoreBytes`.
4. **Actions (opt-in).** Abort, steer/send message, compact. Off by default.

## Decisions

| Question | Decision |
|---|---|
| Layout | **B, card grid** grouped by directory; a card opens the full detail page (`#<session-id>`) |
| Port | Fixed **7317** on `127.0.0.1`, overridable in `~/.pi/agent/dashboard.json` |
| Print mode | `pi -p` / json / rpc runs are **not shown**; interactive (`tui`) main sessions only |
| Stash scope | **Current branch only**, matching `stash_list` |
| Blackhole | **Show what is derivable** from saved entries: observations, reflections, dropped, compactions, last compaction, tokens since compaction. No live gauges and no upstream ask for now |

## Next steps

1. **Spike on the Mac** (phase 0): done, results above.
2. **PR 1, phase 1 MVP (merged):** new `extensions/pi-dashboard` workspace; hub
   (socket lock, spawn, 15s idle exit, HTTP + SSE on 7317); reporter with
   main-session detection and core fields; card-grid index; `/dashboard`
   command; tests; `verify-bundle` assertion. Uses a no-op terminal adapter,
   so it does not depend on the spike.
3. **PR 2, publish hooks (this PR):** `pi-todo:snapshot` and
   `pi-stash:snapshot` events; the dashboard carries bounded task and stash
   metadata in its snapshot (protocol 2, so a running protocol 1 hub steps
   aside) and shows `todos 3/7 · 1 new · stash 2` on cards.
4. **PR 3, phase 2:** detail page with todos, stash index, subagents,
   tokens/cost, blackhole counts; cmux adapter and Focus button using the
   spike results.
5. **PR 4, phase 3:** stash previews, todo timelines, recent activity,
   filtering, notifications, store usage warning.

## ASCII wireframes (chosen layout)

### B. Card grid (index)

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

### Detail page (opened from a card)

```text
┌ ← All sessions ──────────────────────────────────── [Focus in cmux] ┐
│ fix-auth-retry · ~/src/api · agent orchestrator                      │
│ MODEL opus-5.5 │ THINKING high │ STATUS ● bash │ CTX 62% │ $1.84     │
│ ┌ Todos 3/7 ─────────────────┐ ┌ Blackhole ─────────────────────┐    │
│ │ ✓ Reproduce 401 loop       │ │ observations 38  reflections 6 │    │
│ │ ◐ Add retry backoff  (msg) │ │ dropped 11  compactions 3      │    │
│ │ ○ Write regression test    │ │ since last compaction 41k      │    │
│ └────────────────────────────┘ └────────────────────────────────┘    │
│ ┌ Subagents 2 running ───────┐ ┌ Stash 3 · 214 MB / 1 GB ───────┐    │
│ │ Explore: find call sites   │ │ auth-findings 18 KB [Preview]  │    │
│ │ Agent (twin): add tests    │ │ retry-diff     4 KB [Preview]  │    │
│ └────────────────────────────┘ └────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```
