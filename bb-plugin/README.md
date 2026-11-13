# Pi surface (bb plugin)

A [bb](https://getbb.app) plugin that shows Pi sessions running this bundle in
bb's UI. bb runs Pi in RPC mode and drops Pi's widgets, status line and
overlays; the bundle's [`pi-bb`](../extensions/pi-bb/README.md) extension sends
the session's `SessionSnapshot` here instead, and this plugin draws it in bb's
slots. See [bb's UI slots](../docs/bb/ui-slots.md) for every slot with a
screenshot.

Plugin id `pi-surface`, package `bb-plugin-pi-surface`. It is its own package
with its own toolchain, not one of the bundle's npm workspaces.

## Install

```sh
cd bb-plugin
npm install --include=dev
bb plugin install "$PWD" --yes
```

`bb plugin install` builds the plugin. From then on every Pi thread receives
`PI_BB_SURFACE_URL` and `PI_BB_SURFACE_TOKEN`; a running Pi thread picks them up
when bb restarts its process on the next turn. The bundle (with `pi-bb`) must be
installed in Pi as usual.

Try the UI without a model run:

```sh
bb pi-surface fixture --thread <thread-id>   # a canned session on any thread
bb pi-surface list
bb pi-surface clear --thread <thread-id>
```

Fixtures live in memory, never raise a form in the composer, and are refused
for a thread whose Pi session is connected. Remove the plugin with
`bb plugin remove pi-surface --yes`.

## What it shows

| Slot                                | Registration                                                        | Content                                                  |
| ----------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| Composer banner (stack card)        | `app.composer.customize({ banners, chrome: "bare" })`               | Todos card, Subagents card                               |
| Thread context segment              | `app.slots.experimental_threadContextSegment`                       | Agent name, task and subagent counts; opens the Pi tab   |
| Thread context card row and section | `experimental_threadContextCardRow` / `…Section`                    | Stash count; worktrees and pull requests with checks     |
| Composer action                     | `app.composer.customize({ actions })`                               | Opens the Pi tab                                         |
| Composer popup                      | `experimental_popups` + `app.composer.experimental_registerCommand` | Stash picker (Mod+Shift+S, or the + menu)                |
| Thread tab                          | `app.slots.experimental_tab({ context: { kind: "thread" } })`       | Whole session; task history and stash previews on demand |
| Thread row metadata                 | `app.slots.experimental_threadRowMetadata`                          | Open-question and running-subagent badge                 |
| Sidebar navigation                  | `app.slots.navPanel` with `experimental_useBadge`                   | **Pi sessions** page of every connected session          |
| Pending interaction                 | `app.slots.pendingInteraction` + `bb.ui.requestInput`               | pi-ask's open questionnaire as one form                  |

Every slot renders nothing for a thread without a session.
`/plugins/pi-surface/sessions/gallery` (not linked) draws the components that
bb shows only behind experiments, for the docs.

## How it works

- **Sessions.** `bb.http.experimental_websocket("/session", …, { auth: "none" })`.
  A session's first message is `hello` with its thread id and token; the token
  is an HMAC-SHA256 of the thread id under a random secret kept in
  `bb.storage.kv`, so it is valid for that thread only and survives plugin
  reloads. Bad tokens close with 4401, other protocol versions with 4400, and
  an older process for the same thread with 4409 once a newer one says hello.
  The latest snapshot per thread is kept in memory; a disconnected session
  stays 15 seconds, which covers `/reload` and bb's process restarts.
- **Environment.** `bb.providers.experimental_contributeEnv("pi", …)` returns
  `PI_BB_SURFACE_URL` as `{ serverPath: "/api/v1/plugins/pi-surface/http/session" }`,
  which bb's host expands against its `BB_SERVER_URL`, and the thread's token.
  Model listing (no thread) gets nothing. bb shows contributed values in the
  thread's `provider.env-resolved` events, which is one reason the token is
  per thread.
- **App reads.** RPC `snapshot({ threadId })` and `sessions()` are tagged
  `thread:<id>` and `sessions`; the server calls `bb.rpc.experimental_invalidate`
  on every change, so all mounted slots share one live read per thread and
  refresh together over bb's realtime socket. `request({ threadId, request })`
  forwards `stash-preview`, `todo-history` and `answer` to the session and
  waits up to 10 seconds; a fixture answers from canned data.
- **Questions.** When a live session reports an open pi-ask questionnaire, the
  server calls `bb.ui.requestInput` with renderer `questionnaire`; the form's
  answer goes back as an `answer` request, and the form is withdrawn when Pi
  closes the questionnaire. See the limits in the slot doc: pi-ask asks through
  Pi's dialogs in RPC mode today, so live sessions do not report one yet.
- **Dispose.** `bb.onDispose` withdraws open forms and closes every session
  socket; bb itself closes them with 1012 on reload, and pi-bb reconnects.

## Develop

```sh
npm test            # server contract tests (fake host) and component tests (jsdom)
npm run typecheck
npm run build       # bb plugin build .
bb plugin dev       # after installing: rebuild and reload on save
```

Snapshot types come from
[`packages/pi-presentation/src/contract.ts`](../packages/pi-presentation/src/contract.ts)
by `import type`. The root `npm run check` formats and lints this directory
too, except the vendored shadcn copies in `components/ui/`, `lib/` and
`hooks/`, which root oxlint ignores; root `tsc` does not include it.
