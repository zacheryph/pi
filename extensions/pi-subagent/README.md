# @gotgenes/pi-subagents

> Vendored personal copy. Install this repository as one bundle; do not install
> the npm package alongside it. See [local setup and provenance](./UPSTREAM.md)
> and [bundle instructions](../../README.md). Local UI/profile additions are documented below;
> published npm installation instructions refer to upstream.

[![npm version](https://img.shields.io/npm/v/@gotgenes/pi-subagents?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@gotgenes/pi-subagents) [![CI](https://img.shields.io/github/actions/workflow/status/gotgenes/pi-packages/ci.yml?style=flat&logo=github&label=CI)](https://github.com/gotgenes/pi-packages/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![pnpm](https://img.shields.io/badge/pnpm-%3E%3D11-F69220?style=flat&logo=pnpm&logoColor=white)](https://pnpm.io/) [![Pi Package](https://img.shields.io/badge/Pi-Package-6366F1?style=flat)](https://pi.mariozechner.at/)

A [pi](https://pi.dev) extension that gives pi **a focused, in-process sub-agent core** — autonomous agents that run inside the same pi runtime (no spawned subprocesses), plus a typed API and lifecycle events other extensions build on.
Spawn specialized agents that run in isolated sessions — each with its own tools, system prompt, model, and thinking level.
Every agent runs in the background: the parent starts it, ends its turn, and is woken by the completion message. Message any agent with one tool: steer it mid-run, or give a finished one more work. Define your own custom agent types.

> This personal fork is based on [`gotgenes/pi-packages/packages/pi-subagent`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagent),
> itself an independently maintained hard fork of [`tintinweb/pi-subagent`](https://github.com/tintinweb/pi-subagent) by [@tintinweb](https://github.com/tintinweb).
> See [local provenance](./UPSTREAM.md) for the imported revision and [Comparison with upstream](./docs/comparison-with-upstream.md) for the gotgenes–tintinweb comparison.

<img width="600" alt="pi-subagent screenshot" src="https://github.com/gotgenes/pi-subagent/raw/main/media/screenshot.png" />

<https://github.com/user-attachments/assets/8685261b-9338-4fea-8dfe-1c590d5df543>

## Features

- **In-process & native** — agents run inside the same pi runtime (no spawned subprocesses), sharing tool names, calling conventions, and UI patterns (`subagent_start`, `subagent_get`, `subagent_send`) — feels native
- **Parallel background agents** — spawn multiple agents that run concurrently with automatic queuing (configurable concurrency limit, default 4) and individual completion notifications
- **Live widget UI** — compact above-editor widget with a static Subagents header rule and one line per agent: elapsed time, task, and live activity or outcome
- **Session transcripts** — open any subagent's full session transcript (running or with its session released) in pi's native read-only viewer via `/subagent:sessions`
- **Custom agent types** — define agents in `.pi/agents/<name>.md` with YAML frontmatter: custom system prompts, model selection, thinking levels, tool restrictions
- **orchestrate profile** — coordinate long-running projects with categorized todos, delegated work, and follow-ups in prior workers' sessions; available as a subagent or with `pi --agent orchestrate` ([usage and continuity](docs/configuration.md#orchestrate))
- **One input tool** — `subagent_send` reaches an agent in any state, like typing into a main session: it steers a running agent mid-run, and gives an idle one (finished, failed or stopped) a new run that picks up where the agent left off, preserving full conversation context, even after a reload or once its session was released: the saved transcript is reopened.
- **Ask-back** — an agent that needs information only you have calls `ask` (from the bundled pi-ask) and ends its turn, and every result surfaces the question with the exact `subagent_send` call that answers it; once that agent can no longer take a message, the result says so and why instead of naming a call that would be refused
- **Mid-run updates** — an agent that finds something material calls `parent_notify` and keeps working; the message arrives on its own while you are idle and that agent is still running, and otherwise rides that agent's own result, so you hear it exactly once and never as a stale prompt to message an agent that has finished
- **Turn budgets** — `max_turns` is a hard ceiling, and an agent is told how many turns it has left while it still has room to wrap up, so it answers instead of being cut off
- **Case-insensitive agent types** — `"explore"`, `"explore"`, `"EXPLORE"` all work.
  Unknown types fall back to general-purpose with a note
- **Fuzzy model selection** — specify models by name (`"haiku"`, `"sonnet"`) instead of full IDs, with automatic filtering to only available/configured models
- **Context inheritance** — optionally fork the parent conversation into a sub-agent so it knows what's been discussed
- **Styled completion notifications** — background agent results render as themed, compact notification boxes (icon, stats, result preview) instead of raw XML.
  Expandable to show full output
- **Event bus** — lifecycle events (`subagent:created`, `started`, `completed`, `failed`, `queued`, `resuming`, `resumed`, `steered`, `compacted`) emitted via `pi.events`, enabling other extensions to react to sub-agent activity

## Install

```bash
pi install npm:@gotgenes/pi-subagents
```

Or load directly for development:

```bash
pi -e ./src/index.ts
```

## Quick Start

The parent agent spawns sub-agents using the `subagent_start` tool:

```text
subagent_start({
  subagent_type: "explore",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
})
```

Agents always run in the background: the call returns an ID immediately and the completion message wakes the parent when the agent finishes, so the parent can end its turn and stay available while the agent works.
There is no foreground mode and no call that waits for an agent.
The completion message is the only thing that delivers an outcome: it carries the result up to 500 characters, so ask agents to store a large result with `stash_put` and name the handle in their final answer.
In print and json mode (`pi -p`, `--mode json`) nothing can wake the parent once its turn ends, so the process can return before background agents finish.

## UI

The extension renders a persistent widget above the editor showing active agents:

```text
──   Subagents ────────────────────────────────────────────
00:12  agent: Refactor auth module                ⠹ editing…
00:04  explore: Find auth files                ⠹ searching…
 ◦ 1 queued
```

This personal fork uses only a top rule, without side walls or a bottom border.
Pi's own Working border, editor, and footer below it are unchanged.
The header uses the static Nerd Font robot icon (`nf-fa-robot`, U+EE0D);
use a patched Nerd Font, preferably its Mono variant. Each running agent's
activity indicator animates.
Agent rows reserve one leading space before elapsed time and one trailing space
after the activity/outcome indicator. The header rule remains full-width.
Queued agents take no rows; their count is right-aligned on the title bar. Finished agents show their outcome briefly,
with a fixed elapsed duration and the original linger policy.

Task and status columns are truncated by terminal-cell width, including ANSI and
wide Unicode text. Narrow terminals omit elapsed time and the prompt-mode tag.
A height cap prioritizes running, then finished agents; overflow is
reported as a `+N more` footer line. Model, token, context, and turn statistics remain available
in tool results instead of occupying widget space.

Individual agent results render inline in the conversation:

| State          | Example                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------- |
| **Running**    | `⠹ ↻3≤30 · 3 tool uses · 12.4k token (8%)` / `⎿ searching, reading 3 files…`                 |
| **Completed**  | `✓ ↻8 · 5 tool uses · 33.8k token (62%) · 12.3s` / `⎿ Done`                                  |
| **Wrapped up** | `✓ ↻49≤50 · 49 tool uses · 89.1k token (84% · ⇊2) · 45.2s` / `⎿ Wrapped up (budget warning)` |
| **Stopped**    | `■ ↻3 · 3 tool uses · 12.4k token (8%)` / `⎿ Stopped`                                        |
| **Error**      | `✗ ↻3 · 3 tool uses · 12.4k token (8%)` / `⎿ Error: timeout`                                 |
| **Aborted**    | `✗ ↻50≤50 · 50 tool uses · 102.3k token (95% · ⇊3)` / `⎿ Aborted (turn limit reached)`       |

Completed results can be expanded (ctrl+o in pi) to show the full agent output inline.

Background agent completion notifications render as styled boxes:

```text
✓ Find auth files completed
  ↻3 · 3 tool uses · 12.4k token · 4.1s
  ⎿  Found 5 files related to authentication...
  transcript: .pi/output/agent-abc123.jsonl
```

The LLM receives structured `<task-notification>` XML for parsing, while the user sees the themed visual.

## Main-session profile: `--agent`

```bash
pi --agent explore
pi --agent orchestrate "Coordinate the authentication migration"
pi --agent my-profile "Review the authentication flow"
pi --agent my-profile --agent-model anthropic/claude-opus-4-6
```

The local fork can run Pi's **main session** as an agent profile. Profile
frontmatter supplies **startup defaults** for model, thinking, and active tools;
manual changes remain allowed. The Markdown body becomes a named **system-prompt
section**, not text prepended to the initial user task. Normal Pi/project/skill
instructions remain intact. `prompt_mode: append` wraps the body in
`<agent_instructions>`; `replace` omits that wrapper, matching existing child
semantics rather than erasing Pi's prompt.

Use `--agent-model <provider/id>` to override the profile's model startup default
(fuzzy model names also use the existing resolver). Profile thinking and tools
stay unchanged; thinking must be supported by the chosen model. The effective
snapshot records this override without changing the agent definition. An empty
or unavailable override blocks model dispatch, but an unavailable profile model
does not block a valid override.

Core `--model` is not exposed through Pi's extension `getFlag` API. With
`--agent`, core `--model` alone can therefore be replaced by the profile default.
Launchers preserve their explicit model precedence by passing the same model to
both `--model` and `--agent-model`; direct native CLI use needs `--agent-model`
as shown above. This flag has no effect without explicit initial `--agent`, is
never reapplied on `/new`, resume, reload, or tree navigation, and is not passed
to children. Normal child inheritance of the current parent model is unchanged.

Defaults apply only to an explicit `--agent` at CLI startup, including CLI resume.
Omitted values use Pi's current choices; selecting a different model may adjust
thinking to that model's supported level. Ordinary resume/reload preserves manual
settings and restores the saved profile body;
`/new` starts ordinary Pi, even if this process originally used `--agent`.
A branch-relative snapshot preserves exact profile instructions across source
file edits. An explicit `--agent` on a new invocation selects a new snapshot.

Unknown/disabled profiles, unavailable required settings, and untrusted project
profiles produce a diagnostic rather than silently selecting another profile.
Incompatible opaque system-prompt overrides are rejected rather than dropping
the saved profile instructions.
Construction-time tool exclusions cannot be undone; avoid conflicting `--tools`,
`--exclude-tools`, or `--no-tools` flags. Startup errors prevent ordinary model
runs, but Pi's public extension API cannot guarantee a nonzero print/JSON exit
status for a handled startup failure; automation must check diagnostics too.

`subagent_start`, `subagent_get`, and `subagent_send` remain active alongside the
main profile's initial tool list. Children keep existing profile settings and
prompt construction; the main profile body is not inherited. Normal child
defaults that inherit the current parent model or thinking still work as before.
`max_turns` and `inherit_context` are child-only and reported
as skipped for the main session. `locked` controls child caller overrides, not
manual main-session changes.

These are defaults, **not permission enforcement or an OS sandbox**. Active tools
control model declarations; registered codemode/deferred tools may still be
callable indirectly. No main-profile tool deny gate constrains later changes,
child agents, trusted extensions, or nested/virtual model routing.

## Prompt fragments

Profiles can share unconditional system instructions by name:

```yaml
---
fragments: [aws, git]
---
```

Put those files in `agents/fragments/aws.md` and `agents/fragments/git.md`,
beside the winning profile's agents directory (project `.pi/agents` or global
`~/.pi/agent/agents`). Fragments compose in declaration order, then the profile
body, for both `pi --agent <name>` and child agents. No paths or `.md` suffix
in declarations; no cross-scope fallback. Invalid/missing fragments block the
selected profile rather than silently dropping instructions.

`/subagent:agents` previews source paths and composed instructions.
Execution snapshots keep existing content across queueing and resume; new
selection/spawn reads current fragments. See [configuration](./docs/configuration.md#prompt-fragments)
for naming, trust and snapshot rules. Fragments grant no tools or permissions.

## Tools

### `subagent_start`

Launch a sub-agent.

| Parameter         | Type    | Required | Description                                                                                                            |
| ----------------- | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `prompt`          | string  | yes      | The task for the agent                                                                                                 |
| `description`     | string  | yes      | Short 3-5 word summary (shown in UI)                                                                                   |
| `subagent_type`   | string  | yes      | Agent type: one from the tool's list, or a hidden type named elsewhere                                                 |
| `model`           | string  | no       | Model — `provider/modelId`, fuzzy name (`"haiku"`, `"sonnet"`), or `[provider/]family@latest` (newest available match) |
| `thinking`        | string  | no       | Thinking level: off, minimal, low, medium, high, xhigh, max                                                            |
| `max_turns`       | number  | no       | Turn ceiling (minimum 2). Omit for the agent's own limit                                                               |
| `inherit_context` | boolean | no       | Fork parent conversation into agent                                                                                    |
| `cwd`             | string  | no       | Existing directory the agent runs in, such as a git worktree (see below)                                               |
| `handoff`         | object  | no       | Data for extensions in the agent's session (see below)                                                                 |

`handoff` is a JSON object (at most 16 KB) whose top-level keys belong to other extensions, each documenting its key's shape in its own tool guidance. For example, pi-todo reads `todo`. This package does not interpret it: it copies and freezes the object and forwards it on `subagent:session:prepare` and `subagent:session:created`, so an extension can add handoff data without changing pi-subagent.

Before SDK creation, the parent's extensions can synchronously call `requireTools(["exact_tool_name"])` on the `subagent:session:prepare` event. These requirements supplement the profile's allowlist, including `tools: none`; explicit exclusions and the delegation guard still win. Required tools must be active after child extensions bind, or initialization fails and disposes the child. For example, pi-todo requests `todo_list` and `todo_upsert` for `handoff.todo`, so restricted workers can update their assigned tasks without gaining file-editing tools.

`cwd` runs the agent in an existing directory, absolute or relative to the parent's working directory; a missing one is refused before anything is spawned. The caller owns that directory: nothing is removed when the agent finishes, so the agent can keep working there when you send it more. A later `subagent_send` keeps the directory the agent started in. `subagent:session:created` carries the child's `cwd`, chosen or inherited.

These five parameters win over the agent file's own values, which fill whichever the call leaves unset.
An agent file can withhold one with [`locked`](./docs/configuration.md#locking-fields-against-callers); the result then names the agent and the parameters it ignored.

`subagent_start` has no `resume` parameter any more: a call that still sends one starts nothing and says to use `subagent_send`. Starting a second agent would repeat the first one's work.

### `subagent_send`

Send a message to an agent, whatever state it is in, like typing into a main session. The call returns at once; a run it starts reports through another completion message.

| Parameter  | Type   | Required | Description                                                           |
| ---------- | ------ | -------- | --------------------------------------------------------------------- |
| `agent_id` | string | yes      | Agent ID to message; the agent can be in any state                    |
| `message`  | string | yes      | The message; it appears as a user message in the agent's conversation |

What happens depends on the agent's state:

| State                                                                             | What the message does                                                                                                                                                                                       |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Running                                                                           | Steers it: the message interrupts the agent after its current tool execution. Before its session exists, the message is held and delivered when the session initializes. Emits `subagent:steered`.          |
| Queued (waiting for a concurrency slot)                                           | Joins the run that is waiting: the message is added to the prompt the run starts with, so the agent sees it when it starts. Emits `subagent:steered`. A run stopped before its slot opens takes it with it. |
| Idle (finished, failed, hit its turn limit, stopped or interrupted)               | Starts a new run with the message as its prompt, continuing the agent's conversation. The run goes through the concurrency limiter, so it can wait for a slot (`subagent:queued`) before it starts.         |
| Idle and never had a session (stopped while queued, or its session never started) | Starts the agent's first run, from its original task followed by the message, with its original model, tools, directory and context. Announced as a resume, not a second start.                             |
| Unknown ID, or an idle agent whose transcript, directory or agent type is gone    | Refused, saying why; the refusal names the transcript when there is one.                                                                                                                                    |

An idle agent's run continues its live session while it has one.
Once that is gone — the retention window released it, or a `/reload`, `/resume` or session switch dropped it — the agent's saved transcript is reopened instead, with the type, model, thinking level, turn ceiling and directory on its last saved record.
It continues under the same ID and appends to the same transcript file, so results, messages and notifications work as usual, and a record still reading queued or running (a run a reload interrupted) takes a message the same way.
This rebuilds a full session, so the first turn starts more slowly than with a live session.
The agent's current profile for its type applies, and what the spawn passed in `handoff` is not saved, so after a reload a worker does not regain the todo tasks it was handed.
An idle agent that never had a session can be started only while this runtime still holds its spawn configuration: after a reload only the saved record remains, which has no task to start from, so the message is refused and the parent spawns a new agent.
A message is refused when the transcript is gone, when the directory no longer exists (such as a worktree removed with `git_worktree_remove`), or when the agent type is no longer available.

### `subagent_get`

Check the status of an agent and read its full result without waiting for it, or list the agents this branch started.
A running agent is reported as running; its completion message arrives when it finishes.
Reading a finished result does not deliver it again and does not suppress its completion message; it only starts the shorter session-retention window.

| Parameter  | Type    | Required | Description                                          |
| ---------- | ------- | -------- | ---------------------------------------------------- |
| `agent_id` | string  | no       | Agent ID to check; omit to list this branch's agents |
| `verbose`  | boolean | no       | Include full conversation log                        |

Without `agent_id`, the result lists every agent started on the current branch — ID, type, description, status, and the question or error when there is one — waiting on a question first, then running, then idle agents whose last run failed or stopped, then completed ones, newest first.

An agent's ID keeps working after `/reload`, `/resume` or a session switch: when no live agent has it, `subagent_get` answers from the agent's last saved record — status, result, error, the question it ended with, and its transcript path — and says whether `subagent_send` can reach it, using the same check `subagent_send` makes.
An agent still running when that runtime went away is reported as interrupted.
`Agent not found` means the current branch never started that ID, including an agent started on a branch `/tree` has since left.

The result renders as a compact three-line summary — status, stats, description, and a one-line preview.
Press `Ctrl+O` to expand it to the full report, bounded so a long result cannot fill the terminal; the expanded view names the transcript path when it withholds anything.
The complete report, including the conversation `verbose` requests, always reaches the model regardless of what the terminal shows.

## Commands

| Command              | Description                                                                         |
| -------------------- | ----------------------------------------------------------------------------------- |
| `/subagent:settings` | Configure subagent settings (concurrency, turn limits, retention, interrupt policy) |
| `/subagent:sessions` | View a subagent's session transcript (read-only)                                    |
| `/subagent:agents`   | Browse agent profiles and inspect effective settings and instructions (read-only)   |
| `/subagent:watch`    | Toggle the passive, tailing watch overlay (Pi fullscreen mode only)                 |

### `/subagent:settings`

Interactive list to tune runtime settings — max concurrency, default max turns, wrap-up turns, the two session-retention windows, and whether ESC aborts every subagent.
The numeric settings open an input prompt; the abort-on-ESC entry is a direct flip.
Watch-overlay width uses a preset selector (quarter, third, half, two-thirds, four-fifths);
default visibility and thinking visibility are toggles. The overlay starts closed
at third width, with thinking enabled.
Changes persist across pi restarts (see [Persistent Settings](./docs/configuration.md#persistent-settings)).

### `/subagent:agents`

Search agent names, status, and descriptions; Enter opens details. All effective
profiles are listed, including disabled profiles, with project overrides taking
precedence over global and built-in definitions. Details show the name with its
`[visible]`/`[hidden]`/`[disabled]` badge, effective fields and source, then **Description**,
**Guidance** and **Body** sections with the full multiline text. Browsing
never launches an agent or changes settings.

The viewer is the bundle's shared `packages/pi-ui` explorer: centered rounded
frame with padding, prioritized footer hints and an 80% overlay in Pi's
fullscreen TUI (the regular renderer is not supported). Arrow keys navigate;
PgUp/PgDn and Home/End page or jump; the mouse wheel scrolls. Esc returns from
details, clears an active filter, or closes; Ctrl+C closes from either view.
Non-TUI modes do not open the browser. Reopen to refresh the snapshot.

### `/subagent:watch`

`Ctrl+Alt+S` or `/subagent:watch` toggles a read-only overlay anchored at the right
of Pi's **fullscreen** display. It leaves keyboard focus with the editor and
covers content underneath rather than reflowing Pi into a sidebar. Six bottom
rows are left for Pi's dock; tiny terminals suppress the overlay.

Each background agent has a header and an always-tailing output section.
Assistant text and provider-emitted thinking stream live. Compact **Think**,
**Tool**, and **Skill** labels use distinct semantic theme colors; failures use
the error color. Tool calls show one concise argument and a short result/update
summary. Skill reads distinguish loading, successful loading, partial reads, and errors.
Labels describe observed reads, not proof instructions were forwarded or retained;
invocations without an observable read produce no loading evidence.
Inherited conversation, images, and full tool payloads are omitted.
Use `/subagent:settings` to hide thinking; the setting defaults to visible and
updates an open overlay immediately. It cannot reveal reasoning a provider does
not emit. Sections share the height; queued agents get no section and are
counted as `N queued`, right-aligned on the top border (`┌──  Subagents · Ctrl+Alt+S ─── 4 queued ──┐`). Short terminals show an
exact `+N more agents` count, prioritizing running agents, then finished. Finished sections linger for eight seconds. No scrolling or agent
control is provided.

The default is **closed**, with **third** width. Use `/subagent:settings` to
change width or default visibility. The last explicit show/hide choice wins
within the current session: hiding while agents run keeps later runs hidden,
even when the default is open. Automatic hiding after completion does not change
that preference. Session replacement/reload resets it. Hiding never stops agents.

Regular mode retains the existing widget and transcript viewer. The watch command
warns there instead of mounting an overlay: Pi 1.1.0 can bake overlay pixels into
scrollback when parent output grows. A one- or two-row top margin does not prevent
this during output bursts. See [watch-overlay decision](./docs/decisions/0013-passive-watch-overlay.md).

### `/subagent:sessions`

Pick any subagent — running, or completed with its live session already released — and read its full session transcript in pi's native per-entry viewer.
Read-only: no messaging, no session takeover (messages go through the `subagent_send` tool).
Runs that finished earlier in the session stay listed after a `/reload`, and a resumed session lists the runs it recorded; both open from their saved transcript.

The viewer is framed by two rules in the style of pi's editor border, coloured for the agent's thinking level:

```text
── agent  Refactor auth module · anthropic/claude-sonnet-5 • high ───────
… transcript …
── 142 lines · 87% ──────── ↑↓ scroll · PageUp/PageDown · Home/End · Esc close ──
```

The top rule names the agent, its task, model, and thinking level; the bottom carries the scroll position and key hints.
Paging and jumping to the top or bottom follow Pi's viewport keybindings (`tui.altScreen.pageUp`, `pageDown`, `top`, `bottom`), so a remap applies here too, and the footer names the keys you bound; the mouse wheel scrolls the transcript as well.
In fullscreen mode the viewer floats over the bottom of the screen, above Pi's footer, so those keys reach it instead of scrolling the conversation behind it.
On a narrow terminal the footer drops the key hints, and the header drops the task and then the model before it shortens the agent's name.

Creating and editing agent definitions is not a command — write an agent `.md` file in your editor, or ask a pi session to generate one (see [Custom Agents](./docs/configuration.md#custom-agents)).

## Turn Budget

`max_turns` is the ceiling on a run: no turn after turn `max_turns` runs.
An agent is told its remaining budget while it still has room to finish:

1. Once `wrapUpTurns` turns remain (a `/subagent:settings` value, default 2), the agent gets a context message stating how many turns it has left and that the harness stops it after that.
   It reads that message on its next turn, and the message never forces an extra turn.
   When every turn is a wrap-up turn, the budget is stated before the first one.
2. If the agent is still calling tools on turn `max_turns`, the harness stops it and the run ends `aborted`.
   An agent that gives its final answer on that turn finishes normally.

Only successful turns count: a response that errored and was retried does not spend budget.
The minimum `max_turns` is 2, one turn to work and one to answer; a smaller value runs with 2, and the spawn result says so.
A resumed agent gets a fresh budget with its original ceiling.

| Status      | Meaning                                | Icon       |
| ----------- | -------------------------------------- | ---------- |
| `completed` | Finished naturally                     | `✓` green  |
| `completed` | Finished after the turn-budget warning | `✓` yellow |
| `aborted`   | Still working at the ceiling; stopped  | `✗` red    |
| `stopped`   | User-initiated abort                   | `■` dim    |

The budget itself is the `turnBudget` field (`{ used, maxTurns, phase }`) on the subagent record, tool-result details, notifications, and the terminal events.
It is live while the agent runs: `used` counts the run's successful turns, `maxTurns` is absent for an unlimited run, and `phase` is `within`, then `warned` once the warning was sent, then `exhausted` when the harness stopped the run (always paired with `aborted`).
The widget shows a warned agent's turn count in the warning color.

## Concurrency

Every agent is subject to a configurable concurrency limit (default: 4).
Excess agents are automatically queued and start as running agents complete.
The widget shows queued agents as a collapsed count.
It also bounds its own height to the terminal's, collapsing the agents that do not fit into a `+N more` summary, so a short pane keeps its conversation visible.

Stopping a still-queued agent produces the same completion notification a running agent's stop does.
Because that agent never started, the notification says so and offers no result to collect.

A run that `subagent_send` starts for an idle agent goes through the same limit as a first run. With a slot free it starts at once; with every slot taken, the call returns "Agent resume queued in background", `subagent:queued` is emitted, the widget and the dashboard show the agent as queued again, and the run starts when a slot opens. A message sent to an agent that is still queued joins its waiting run. Stopping a queued run leaves the agent as it was after a stop: idle, and open to another message.

## Child session lifecycle

A child session runs in the parent's process but is a full Pi session with its own extension set.
It receives the standard pair of session lifecycle events:

| Event              | When                                                | Reason                                                      |
| ------------------ | --------------------------------------------------- | ----------------------------------------------------------- |
| `session_start`    | Extensions are bound, before the child's first turn | `"startup"`, or `"resume"` when its transcript was reopened |
| `session_shutdown` | The child session is disposed                       | `"quit"`                                                    |

Disposal happens when the retention window for a finished agent expires, when the in-memory records of finished agents are cleared at session start or switch, when the parent session shuts down, or when child extension binding fails partway.
Clearing them loses no history: the session keeps every agent's saved record (see [Saved records and the roster card](#saved-records-and-the-roster-card)).
It does **not** happen the moment an agent finishes: the session is retained so a resume is cheap, per the `consumedSessionRetentionMinutes` and `unconsumedSessionRetentionMinutes` settings above. A released agent still takes `subagent_send`, which reopens its transcript, at the cost of rebuilding the session.

The shutdown event is dispatched and awaited **before** the child's `AgentSession` is disposed, so a handler still has a live context and can close what it opened — stdio subprocesses, sockets, timers, file handles.
Each child's shutdown is bounded: a handler that never resolves is abandoned after a few seconds and disposal proceeds, so one misbehaving extension cannot stall the parent's teardown or Pi's exit.

If you author an extension that runs in children, note that its `session_shutdown` handler now fires **once per child session** in addition to once for the parent.
A handler that flushes a log, writes a summary, or closes a shared resource should be safe to run repeatedly within one process.
Before this behavior existed, children fired `session_start` with no matching shutdown, so extension-owned resources accumulated for the life of the parent process.

## Saved records and the roster card

The parent session appends a `subagent:record` custom entry for every lifecycle step of each agent it starts: when the agent is queued or starts running, when a resume starts, and when a run settles — including a run that ended its turn with a question.
Each entry carries the agent's ID, type, description, status, result, error, turn budget, timings, tool count and transcript path, plus the question it is waiting on, its model and thinking level, the turn ceiling the spawn asked for, and the directory it runs in.
The last entry for an ID wins.
An entry records the agent's `status` (`queued`, `running` or `idle`) and, once idle, the `outcome` of its last run (`completed`, `turn-limit`, `error`, `stopped` or `interrupted`). Entries written before this shape, with a `status` of `completed`, `aborted`, `error`, `stopped`, `queued` or `running`, are still read: the first four become idle with that outcome, and a queued or running one becomes idle and interrupted.
The entries sit on the branch that started the agent, so they follow it through `/tree` and forks, and entries written by older versions without the newer fields still load.
Once the child session is ready, another running entry saves its resolved model, directory and transcript path so an interrupted run can be inspected.
Lifecycle updates from an agent hidden by `/tree` do not add it to the new branch; the latest update is held in memory and written when `/tree` returns to a branch containing that agent.

After a compaction, `/reload`, `/resume` or `/tree`, the model may have lost track of the agents it started.
Until it lists them with `subagent_get` (no `agent_id`), each request ends with a roster card built from the branch's records and any still-live agents:

```text
Subagents started by this session (restored after compaction; subagent_get <id> for details, subagent_send <id> to give an idle one more work):
- 9a8b7c implementer "Migrate session store": waiting for your answer: "Postgres or SQLite?"
- d4e5f6 review "Review roadmap step 3": running
- a1b2c3 implementer "Add token refresh": idle, last run completed 14:10
- 77e0aa explorer "Map auth call sites": idle, last run failed: turn budget exhausted
- 2 older completed agents not shown
```

The card is added to the request only: it is never written to the transcript or shown in the terminal.
It holds at most 20 agent lines, dropping the oldest failed and completed agents first and counting them on the last line; waiting and running agents are never dropped.
An idle agent shows how its last run ended, and `(cannot take a message)` when `subagent_send` would refuse it (its transcript or directory is gone). Descriptions are cut to 80 characters and questions to 160, without splitting a wide character or emoji.
A branch that started no agents gets no card.

## Events

Agent lifecycle events are emitted via `pi.events.emit()` so other extensions can react:

| Event                       | When                                                                             | Key fields                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `subagent:created`          | Agent registered                                                                 | `id`, `type`, `description`                                                                                              |
| `subagent:started`          | Agent transitions to running (including queued→running)                          | `id`, `type`, `description`                                                                                              |
| `subagent:completed`        | Agent finished successfully                                                      | `id`, `type`, `status`, `turnBudget`, `durationMs`, `tokens` (lifetime `{ input, output, total }`), `toolUses`, `result` |
| `subagent:failed`           | Agent errored, stopped, or aborted                                               | same as completed + `error`, `status`                                                                                    |
| `subagent:queued`           | A message gave an idle agent a run that waits for a slot                         | `id`, `type`, `description`                                                                                              |
| `subagent:resuming`         | An idle agent's new run started (also an agent's first run started by a message) | `id`, `type`, `description`                                                                                              |
| `subagent:resumed`          | That run reached a terminal state (completed/error)                              | same as completed + `error`, `status` (`buildEventData` shape) — `status`/`error` discriminate                           |
| `subagent:steered`          | Message delivered to a running agent, or added to a queued agent's waiting run   | `id`, `message`                                                                                                          |
| `subagent:compacted`        | Agent's session successfully compacted                                           | `id`, `type`, `description`, `reason` (`"manual"` / `"threshold"` / `"overflow"`), `tokensBefore`, `compactionCount`     |
| `subagent:settings:loaded`  | Persisted settings applied at extension init                                     | `settings` (merged global + project)                                                                                     |
| `subagent:settings:changed` | `/subagent:settings` mutation was applied                                        | `settings`, `persisted` (`boolean` — `false` on write failure)                                                           |

`tokens.total` = `input + output + cacheWrite`.
`cacheRead` is excluded — each turn's `cacheRead` is the cumulative cached prefix re-read on that one API call, so summing per-message would over-count it.
Use `contextUsage.percent` (surfaced as `(NN%)` in the widget) for current context size.

## Worktree Isolation

Worktree isolation is not part of this core.
A caller that prepared a directory, such as a git worktree, passes it as `subagent_start`'s `cwd`; the child runs there and keeps taking messages there, and the directory is never removed for it.
The earlier `isolation: "worktree"` spawn flag and `isolation:` frontmatter key were removed from the core.

## Removed: agent memory and skill preloading

Persistent agent memory (the `memory:` frontmatter key) and skill preloading (the `skills:` frontmatter key) were removed when the core was slimmed down.
Children inherit the parent's skills and extensions by default, so the `isolated`, `extensions`, and `skills` frontmatter keys no longer exist.
Package-level extension opt-outs live in the [`excludedExtensionPackages`](./docs/configuration.md#excluding-package-extensions-from-children) setting rather than agent frontmatter.

## Migrating from `disallowed_tools`

The `disallowed_tools` frontmatter field has been removed.
Use [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-permission-system)'s `permission:` frontmatter instead — it provides richer semantics (allow/ask/deny vs. binary hide):

```yaml
# Before (no longer supported)
disallowed_tools: bash

# After
permission:
  bash: deny
```

## Permission System Integration

When [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-permission-system) is installed, this extension integrates automatically:

- **Per-agent permission policies** — define `permission:` in agent YAML frontmatter to set allow/ask/deny rules per agent type.
  The permission system resolves the agent name from the `<active_agent>` tag in the child system prompt.
- **Tool filtering** — the permission system's `before_agent_start` handler removes denied tools from the child session before the agent starts.
- **`ask`-state forwarding** — when a child session triggers an `ask` permission, the prompt forwards to the parent session's UI.
  The parent approves or denies, and the child resumes.
- **Deterministic child detection** — this extension publishes `subagent:session:created` before `bindExtensions()` fires; the permission system subscribes and registers the child session synchronously, so detection does not rely on env vars or filesystem heuristics.
- **Unguarded children are announced** — this extension also publishes `subagent:session:bound` once a child's extensions have bound; the permission system uses it to notice a child that loaded no permission node of its own — the case [`excludedExtensionPackages`](docs/configuration.md#excluding-package-extensions-from-children) can create — and warns rather than letting it run ungated in silence.

No configuration is required.
When `@gotgenes/pi-permission-system` is not installed, the lifecycle events have no subscriber — a harmless no-op.

## For Extension Authors

### Extensions that append to the system prompt

If your extension appends to the system prompt from a `before_agent_start` handler, your parent-session block does **not** ride into child sessions.
A child inherits only the stable part of the parent's prompt — everything Pi assembled ahead of the skills catalogue, and ahead of `<project_context>` too for a child running in another directory — so anything appended after that is dropped.
See [What a child inherits from the parent's prompt](./docs/configuration.md#what-a-child-inherits-from-the-parents-prompt) for the full layer breakdown.

This is usually invisible to you, because your handler runs in the child too: a child binds the parent's extension set, and its turn loop fires `before_agent_start` the same way the parent's does.
An unconditional appender therefore writes a fresh block built for the child's own session — which is what you want, since the parent's copy named the parent's directory, model, and session.

Two cases need care:

- A handler gated on something a child lacks — an interactive UI, a terminal, or state your extension cached at `session_start` — appends nothing in the child.
  That child now carries no block at all, where previously it inherited one built for the parent.
  If your guidance applies to children, make the handler unconditional or derive its inputs from the event context rather than from cached session state.
- An extension excluded from children through [`excludedExtensionPackages`](./docs/configuration.md#excluding-package-extensions-from-children) contributes nothing to a child by design, and no longer leaks its parent-session block in either.

Extensions that _shape_ the prompt at the provider boundary rather than appending to it are unaffected — the region they rewrite is the identity a child inherits verbatim.

An extension that states something **per session** — which tools this session may call, which skills it loaded — should append it rather than edit the inherited identity, even when Pi wrote its own copy up there.
Editing that region rewrites bytes the child inherited from its parent, which ends the prefix the two share ([#890](https://github.com/gotgenes/pi-packages/issues/890)).
Pi's own `<tools>` and `<rules>` sections are the exception: they describe one session's tools, so a child drops its parent's copies, and a per-session tool statement belongs after `<cwd>` ([ADR 0011](./docs/decisions/0011-tool-surface-sections-are-session-resolved.md)).

## Scope and non-goals

**Purpose.**
A minimal, in-process sub-agent core.
It spawns a child session derived from the parent, runs the turn loop, streams and collects the result, gates concurrency, supports resume, and publishes its lifecycle.
Everything else is a consumer.

**In scope.**
Defects in the surfaces the core already owns, completeness of the public lifecycle-event contract, and internal work toward the minimal-core target.
Anything attaching to the core subscribes to a lifecycle event — see [ADR-0002](./docs/decisions/0002-extensions-on-a-minimal-core.md).

**Non-goals.**

- _Capability the fork deliberately left behind._
  Scheduling, cross-extension RPC, model-scope enforcement, and a built-in tool denylist belong to upstream — see [Relationship to upstream](#relationship-to-upstream).
- _Policy about what a child may do._
  Tool restriction is allow/ask/deny in a permission layer, not a binary hide in a spawner — see [Migrating from `disallowed_tools`](#migrating-from-disallowed_tools).
- _Settings-level overrides of an agent's tool selection._
  An agent's `tools:` frontmatter chooses its capabilities: omitted or `all` includes currently registered built-in and extension tools; explicit names restrict them; `-name` excludes. A global setting that widens a read-only `explore` agent's declared tools would violate its contract.
  The core does install its own protocol in every child — the `<active_agent>` tag, the parent-context prefix, the `ask:route` that points pi-ask's `ask` at the parent, and the `parent_notify` tool — none of which reaches the filesystem, the shell, or the network.
- _A global run-mode default._
  Agents always run in the background; there is no run mode to set.
- _Provider seams with no consumer._
  A seam nobody supplies is a speculative abstraction that taxes every reader; the architecture may admit one without shipping it until a real consumer exists.

The [architecture doc](./docs/architecture/architecture.md#scope-and-non-goals) carries the full inventory, including the removed UI surfaces and the reasoning behind each.

**Where adjacent requests belong.**
Tool restriction and per-agent permission policy → [@gotgenes/pi-permission-system](https://www.npmjs.com/package/@gotgenes/pi-permission-system).
Worktree isolation → a git worktree passed as `cwd` (pi-git's `git_worktree_create`).
Timed dispatch, telemetry, and alternate UIs → a consumer over the lifecycle events.
A batteries-included alternative → upstream [`tintinweb/pi-subagent`](https://github.com/tintinweb/pi-subagent).

## Documentation

| Document                                                       | Contents                                                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Configuration](./docs/configuration.md)                       | Default agent types, custom agent files and their frontmatter fields, and the `subagent.json` settings file    |
| [Architecture](./docs/architecture/architecture.md)            | Design principles, domain decomposition, module dependency flow, Mermaid diagrams, and the improvement roadmap |
| [Comparison with upstream](./docs/comparison-with-upstream.md) | Feature-by-feature comparison against the current upstream release                                             |

## Architecture

This extension is a minimal, composable core: it owns agent spawning, execution, and result retrieval, and publishes lifecycle events that other extensions build on.

## Relationship to upstream

This package is an independently maintained hard fork of [`tintinweb/pi-subagent`](https://github.com/tintinweb/pi-subagent) by [@tintinweb](https://github.com/tintinweb).
It has diverged substantially in scope and architecture: a minimal core with lifecycle events, with tool-restriction policy and worktree isolation delegated to companion packages.
Upstream remains the batteries-included option, keeping scheduling, cross-extension RPC, model-scope enforcement, and a built-in tool denylist in a single package.

See [Comparison with upstream](./docs/comparison-with-upstream.md) for a full feature-by-feature comparison against the current upstream release and guidance on which to choose.

## License

MIT — [tintinweb](https://github.com/tintinweb) (upstream) and [Chris Lasher](https://github.com/gotgenes) (fork)
