# Cloning or extending bb's Pi provider

Question: what would it cost to make "which agent runs as the root session" a
choice in bb's model selection, by cloning or extending bb's Pi provider?

Answer: possible, and the licence allows it, but a fork is the expensive way.
Pi's virtual models put an agent in the model picker with no bb code at all.
Keep the fork as a fallback.

Measured on [`get-bb/bb`](https://github.com/get-bb/bb) at `63df380`
(2026-11-12), MIT licence.

## Size

| Part                                                             | Lines | Files |
| ---------------------------------------------------------------- | ----: | ----: |
| Bridge, translation and catalog (`src/`, `server.ts`, `app.tsx`) | 7,198 |    23 |
| Test support and test config                                     |   340 |     4 |
| Tests                                                            | 8,832 |    39 |

Largest source files:

| File                                 | Lines | Role                                                      |
| ------------------------------------ | ----: | --------------------------------------------------------- |
| `src/bridge/rpc-session.ts`          | 1,354 | One Pi process: prompts, steering, compaction, settlement |
| `src/delta-translation.ts`           | 1,339 | Pi session events to bb timeline deltas                   |
| `src/bridge/bridge.ts`               | 1,262 | Provider Bridge Protocol methods                          |
| `src/bridge/catalog.ts`              |   427 | Model list per directory                                  |
| `src/bridge/rpc-child.ts`            |   421 | Spawn, stdio framing, exit handling                       |
| `src/bridge/provider-maintenance.ts` |   385 | Install and version checks                                |
| `src/bridge/bb-pi-extension.ts`      |   385 | The extension bb injects into Pi                          |
| `src/visibility.ts`                  |   383 | Which Pi events show                                      |
| `app.tsx`                            |   193 | Renderer for extension dialogs                            |

The shipped `host.js` is 576 KB, but 469 KB of that is the plugin SDK and zod.

## Churn

Commits touching `plugins/provider-pi`:

| Month                 | Commits |
| --------------------- | ------: |
| 2026-08               |      16 |
| 2026-09               |      32 |
| 2026-10               |      26 |
| 2026-11 (to the 12th) |       9 |

About 25 a month. Recent ones change how the bridge channel is carried, how
managed installs update and how images are passed: the internals a fork would
have to keep merging.

## Coupling

- Built on `@get-bb/plugin-sdk/provider-bridge`, whose surfaces are
  `experimental_`-prefixed and listed in bb's `docs/api_to_audit.md`.
- Contract documents: `docs/provider-plugin-api.md` (495 lines) and
  `docs/provider-bridge-protocol.md` (677 lines).
- Recorded-conformance tests live outside the plugin, in
  `packages/provider-parity`, against recordings in
  `packages/provider-bridge-protocol`.
- Tracks Pi's RPC event shapes directly; the plugin's own tests pin Pi 0.84.4
  types while the install here is 1.5.2.

## Ways to pick the agent

|                                         | Where the choice appears                    | bb code to own              | Cost                                                       |
| --------------------------------------- | ------------------------------------------- | --------------------------- | ---------------------------------------------------------- |
| **A. Virtual models in Pi**             | Model picker, as `agent/<name>`             | None                        | About 200 lines in `pi-subagent`                           |
| **B. Environment variable**             | Project setting, or a small plugin's picker | None, or a ~100-line plugin | About 60 lines in `pi-subagent`                            |
| **C. Fork with a session option**       | Option beside the model picker              | 7,200 lines plus tests      | About 300 changed lines, then ~25 upstream commits a month |
| **D. Upstream change**                  | Option beside the model picker              | None                        | A pull request to bb                                       |
| **E. Proxy around the built-in bridge** | Option beside the model picker              | A wrapper                   | Depends on bb's internal artifact layout; not recommended  |

### A. Virtual models in Pi (recommended)

Pi lets an extension register a virtual model: a selectable model that routes
each request to a physical one (`pi.registerVirtualModel`). bb's model list
comes from Pi's `get_available_models` in a process that loads your
extensions, so a virtual model `agent/orchestrate` is listed like any other.

`pi-subagent` registers one per agent profile. Selecting it applies the
profile (instructions, tools) and routes to the profile's model. bb's
reasoning picker passes through as the virtual thinking level.

Limits:

- The model picker then carries two meanings. An agent whose profile names no
  model needs a default to route to.
- bb's catalog is cached per machine for about a minute and refreshed in the
  background; a new agent file appears after that.
- To confirm: that bb's listing shows a virtual model. Pi documents that
  virtual models appear wherever models do; bb's filter has not been run
  against one.

### B. Environment variable

`pi-subagent` reads `PI_MAIN_AGENT` when `--agent` is absent. bb sets it per
project (`bb machine env set PI_MAIN_AGENT --project <id>`) or per thread
through a plugin's `experimental_contributeEnv`. Useful as the default under
A, and for hosts other than bb. No choice in the model picker.

### C. Fork with a session option

bb's protocol already supports it: a `model/list` entry may carry
`sessionOptions` (a `select` or `boolean`), the new-thread picker shows them,
and the choices arrive on the thread's first commands. The Pi provider reports
none. A fork would:

1. List the agents in `catalog.ts`, by asking the catalog's Pi process, and
   attach a `select` option `agent` to every model entry.
2. Carry `sessionOptions.agent` through `session-params.ts` into the child
   environment as `PI_MAIN_AGENT`. The session already restarts when its
   environment changes.
3. Cover both in the bridge tests and the fake Pi.

About 300 lines. The cost is what follows:

- It must ship under another provider id; the built-in `pi` cannot be
  replaced. Threads record their provider id, so existing threads stay on the
  built-in one, and both appear in the picker unless one is disabled.
- Every bb release needs a merge of the upstream plugin and a rebuild against
  that release's SDK. At 25 commits a month in 7,200 lines, expect conflicts
  in `catalog.ts` and `rpc-session.ts` regularly.
- An SDK change to an `experimental_` surface can stop the fork loading until
  it is ported.

### D. Upstream change

The same 300 lines as a pull request to `get-bb/bb`, ideally generic: let the
provider ask Pi's side for extension-declared session options instead of
knowing about agents. No maintenance afterwards. Worth filing once A shows
what the option should look like.

## Recommendation

1. Build A and B in `pi-subagent`. Both are in
   [the plan](../plans/rpc-surfaces.md).
2. File D with bb.
3. Fork (C) only if upstream declines and the model picker proves the wrong
   place for the choice.
