# Changelog

Local changes to this vendored copy, newest first. Where it came from is
recorded in [UPSTREAM.md](UPSTREAM.md).

## 2026-11-05: Opt into delegation with `delegate: true`

A child could start agents of its own only if its `tools` named each of
`subagent_start`, `subagent_get` and `subagent_steer`, while `all` did not
count. The one capability that needs a deliberate choice was hidden in an
allowlist quirk, and the docs' own example misnamed the tools.

- Add `delegate: true` frontmatter. It adds all three delegation tools to the
  child, even under an allowlist that names none of them; an explicit
  `-subagent_*` exclusion still wins. Without it they are withheld, including
  when `tools` names them.
- The built-in orchestrator declares `delegate: true` and no longer lists the
  delegation tools in `tools`.
- `SessionConfig` carries `delegate`; `/subagent:agents` shows a Delegate
  field. A main session is unchanged: it always has the delegation tools
  unless `tools` excludes them.
- Fix the configuration docs' example, which named `todo` and `subagent`
  rather than the real tool names.

## 2026-11-05: A malformed agent file no longer breaks every agent

`parseFrontmatter` throws on invalid YAML, and nothing caught it. One bad file
in `.pi/agents/` or the global agents directory made the whole registry load
throw, and `subagent_start` reloads the registry on every call, so every spawn
failed (and extension load could too).

- Catch the parse error per file. The file still registers under its name,
  with `definitionError` naming the path and the first line of the error, so
  it keeps overriding a lower-priority agent rather than silently handing the
  name back to a global or built-in one.
- An agent with `definitionError` is not listed, not available, fails
  `isValidType`, and its spawn throws `Agent type "<name>" cannot load: …`.
  Selecting it as the main profile fails the same way.
- `/subagent:agents` badges it `[invalid]` and shows a Definition error
  section above its description.

## 2026-11-05: Agent files default to `prompt_mode: replace`

An agent file without `prompt_mode` was an `append` agent: its body wrapped in
`<agent_instructions>` beneath the caller's prompt and labelled `(twin)` in
the widget. Nearly every agent with a role of its own wants `replace`, so a
file that forgot the key quietly behaved, and looked, like a parent twin.

- An omitted or unrecognized `prompt_mode` now means `replace`. Only
  `prompt_mode: append` selects `append`; `general-purpose` already sets it.
- Update the configuration docs and the `creating-agents` skill.

## 2026-11-05: Add the `creating-agents` skill

The `subagent_start` description no longer explains where agent files live,
and that one sentence was never enough to write a good agent.

- Add `skills/creating-agents/SKILL.md`: when an agent type beats a skill,
  file locations and precedence, every frontmatter field, writing
  `description` and `guidance` for the type list, `prompt_mode`, tools,
  `visibility`, `locked`, fragments, body structure, an example, and how to
  check the result.
- Ship `skills/` in the package and declare it in `pi.skills`, so a
  standalone install loads the skill as well as the bundle.

## 2026-11-05: Built-in agents are markdown files

The five built-in agents were TypeScript object literals, in a different shape
from the `.md` files users write, with a separate `isDefault` flag.

- Move `general-purpose`, `orchestrator`, `Explore`, `Plan` and `reviewer` to
  `agents/<name>.md`, loaded by the same parser as `.pi/agents/*.md` with
  `source: "default"` and a real `sourcePath`, so a built-in can also use
  prompt fragments from `agents/fragments/`. Ship `agents/` in the package.
- `default-agents.ts` only loads that directory. Every directory now loads in
  case-insensitive name order, so the built-ins list as Explore,
  general-purpose, orchestrator, Plan, reviewer.
- Remove `AgentConfig.isDefault` and `AgentTypeRegistry.DEFAULT_AGENT_NAMES`;
  `source === "default"` identifies a built-in. `/subagent:agents` shows its
  source as `built-in` and its file path.
- The prompts are unchanged in wording; the formatter adds the blank lines
  Markdown expects after headings and around lists.

## 2026-11-05: One dense agent list in the `subagent_start` description

The description split agents under "Default agents:" and "Custom agents:",
showed a model only for built-ins, repeated each built-in's name in a separate
"Use X for …" guideline line, listed the type names a third time in the
`subagent_type` parameter, and carried instructions for writing agent files.
Whether an agent is built in or custom does not help a caller choose one.

- Add `guidance` frontmatter: when to pick the agent. It replaces the built-in
  only `toolGuideline`, so custom agents can carry it too.
- `buildTypeListText` renders one line per listed agent, built-in and custom
  alike: `- name (model): description. guidance`. Multi-line values collapse
  onto the line; the model shows for any agent that pins one.
- Remove `buildAgentGuidelines`, the registry's `getDefaultAgentNames` and
  `getUserAgentNames`, the type names in `subagent_type`'s description, and
  the agent-authoring paragraph. `AgentTool` no longer takes `agentDir`.
- Reword the built-ins so description and guidance do not repeat each other,
  and describe `general-purpose` as a copy of the caller to use only when no
  other type fits. The orchestrator now picks workers by that guidance and
  falls back to `general-purpose` last.
- The `/subagent:agents` detail view shows a Guidance section in place of
  Tool guideline.

## 2026-11-05: Replace `enabled` with `visibility`

`enabled: false` was the only way to take an agent out of the
`subagent_start` list, and it also refused every spawn. An agent meant only
for a skill or another agent to name had no way to stay unlisted yet
runnable.

- Add `visibility: visible | hidden | disabled` to agent frontmatter and
  `AgentConfig`. `hidden` leaves the agent out of the tool's type list but
  spawns it by name; `disabled` refuses it as `enabled: false` did. An
  unrecognized value is dropped and the agent stays visible.
- Remove `enabled`; a file that still sets it has the key ignored.
- `AgentTypeRegistry.getListedTypes()` returns the visible types;
  `getAvailableTypes()` and `isValidType()` accept hidden ones.
- The `/subagent:agents` browser badges each agent `[visible]`, `[hidden]`
  or `[disabled]` and shows a Visibility field in place of Enabled.

## 2026-11-05: The caller alone decides foreground or background

An agent file's `foreground` key let a profile pick how it ran whenever the
caller left `foreground` unset. How an agent runs is the caller's decision, so
the key is gone.

- Drop `foreground` from agent frontmatter, `AgentConfig`, and the lockable
  fields. A file that still sets it, or locks it, has that entry ignored.
- Collapse `BackgroundRequest`'s `explicit`/`default` union to a boolean
  `background`, and remove `resolveBackgroundMode`, which existed only to let
  the profile fill a `default` request.
- Remove the Foreground row from the `/subagent:agents` detail view and the
  main-profile "subagent-only fields skipped" notice.

## 2026-11-04: Register the agent definitions browser as `/subagent:agents`

The read-only agent profile browser was still registered, but as `/agent`
after the identifier rename, so `/agents` (and its old `/subagents:agents`
name) no longer matched any command and the browser looked gone.

- Register the browser as `/subagent:agents`, under the extension's prefix
  like its other commands.
- Pin the extension's command names in a composition-root test.

## 2026-11-04: Add a four-fifths watch-overlay width preset

- Add `four-fifths` (80%) to the overlay width selector and persisted settings.
- Extend settings and overlay tests to cover selection, persistence, and live resizing.

## 2026-11-04: Serialize cold-resume setup and preserve resolved turn limits

- Wait for a released session's shutdown before reopening its transcript, so
  its late disposal cannot unregister the new session under the same ID.
- Refuse another resume while a stopped cold rebuild is still unwinding; the
  stopped setup must dispose its session before a replacement can start.
- Keep the previous run's resolved turn ceiling, including unlimited runs,
  across release and reload rather than resolving it from changed defaults.
- Add lifecycle regressions and real SDK reload coverage for these paths.

## 2026-11-04: Cold resume a released subagent from its saved transcript

`resume` only continued an agent's live `AgentSession`, and was refused once
that was gone: after a retention window, or at once after a reload, resume,
restart or session switch. The transcript was still on disk. A resume now
reopens it and continues, automatically, inside the existing `resume` call.

- `src/lifecycle/cold-resume.ts`: `reopenRefusal`, the check of whether a
  transcript can be reopened (it still exists, the recorded directory still
  exists, the agent type is still usable), and `resolveSavedModel`.
- `src/lifecycle/subagent-manager.ts`: `resumeRefusalFor` is the one check
  `startResume`, `subagent_get` and the roster card share. An ID with no live
  record but a saved one on the branch gets a record rebuilt from it, through a
  new `savedAgents` option. A refusal for good names the transcript.
- `src/lifecycle/subagent.ts`: a resume of a released session builds a new one
  around the transcript, then runs as any resume does. A steer sent meanwhile is
  buffered; a stop sent meanwhile disposes the new session instead of running it.
  A released record whose workspace was torn down stays `workspace-disposed`.
- `src/lifecycle/create-subagent-session.ts`: `transcriptPath` reopens through a
  new `openSessionManager` dependency, and the child's `session_start` reports
  `resume`. Pi appends to the reopened file, so the transcript stays one file.
- `src/lifecycle/subagent-session.ts`: `applyTurnLimits`, so a session with no
  initial run still resumes under its recorded ceiling.
- `ResumeRefusal` gains `directory-unavailable` and `agent-type-unavailable`;
  `session-released` now means the transcript is gone too.
- `subagent_get` and the roster card report whether an agent can be resumed, and
  the README, tool guidance and orchestrator profile describe all of this.

## 2026-11-04: Keep lifecycle records on their branch and save ready-session metadata

- Off-branch start, session-ready, resume and terminal events no longer admit
  hidden agents to the current branch. Their latest saved state is deferred
  until `/tree` returns to a branch containing the agent.
- Session creation now appends the resolved model, directory and transcript
  path while the agent is still running, so interrupted runs retain a path to
  their partial work.
- Added branch-transition regressions using the real session manager and an
  SDK recovery test for a record captured before a child finishes.

## 2026-11-04: Record the whole agent lifecycle, answer `subagent_get` from it, and restore a roster card

After a reload, resume or session switch, `subagent_get` answered `Agent not
found` for every agent the parent had started, and a worker waiting on a
question lost both the question and the way to see it. After compaction the
parent kept only the worker IDs its summary happened to mention. The
`subagent:record` entry now records every lifecycle step, `subagent_get`
answers from it and lists the branch's agents, and a context-only card
restores them to the model.

- `src/persisted-record.ts`: the parent appends `subagent:record` when an
  agent is queued or starts running, when a resume starts, and at every
  terminal state, as before. Entries gain optional `pendingQuestion`, `model`
  (`provider/id`), `thinkingLevel`, `maxTurns` and `cwd`; an unknown one is
  left off rather than written as `undefined`. `readPersistedRecords` folds a
  branch's entries into the last valid record per ID; entries without the new
  fields still validate, and malformed ones are skipped. `readPersistedRuns`
  is built on it.
- `src/observation/subagent-events-observer.ts`: `onSubagentCreated`,
  `onSubagentStarted` and `onSubagentResuming` persist the record too. The
  parent session writes them, so they follow its branch through `/tree` and
  forks.
- `src/lifecycle/subagent.ts`: `maxTurns` and `cwd` getters (`cwd` is the
  caller's directory, or once the run starts the provider's workspace or the
  parent's directory).
- `src/roster.ts` (new): the branch's agents, folded from its records and
  overlaid with live state, ordered waiting on a question, running, failed,
  then completed newest first. A record still reading queued or running with
  no live agent is reported as interrupted. Formats the roster line, the card
  (20 whole lines at most; waiting and running agents never dropped; the last
  line counts what was left out) and the list. Descriptions are cut to 80
  characters and questions and errors to 160, after stripping terminal
  controls, at grapheme boundaries so wide characters and emoji stay whole.
- `src/tools/get-result-tool.ts`, `src/tools/get-result-report.ts`:
  `agent_id` is optional; without it `subagent_get` lists the branch's agents
  with `details.kind: "list"`. An ID is visible only if the current branch
  holds a record for it, so a live agent started on a branch `/tree` has left
  is hidden. When no live agent has the ID, the report comes from the saved
  record — status, result, error, question, model, directory and transcript
  path — and says the agent cannot be resumed because its live session ended.
  `Agent not found` now says the branch never started the ID.
- `src/handlers/roster-card.ts` (new), `src/index.ts`: a `context` handler,
  following pi-stash's pattern, strips its own card and appends a fresh one as
  a `custom` message with `display: false`, never written to the transcript.
  It is armed by `session_start` (reload, resume, fork), `session_tree` and
  `session_compact` when the branch already has agents, and stops once a
  successful `subagent_get` list result arrives after that event. A branch
  with no agents gets no card.
- `src/tools/agent-tool.ts`, `src/tools/steer-tool.ts`: the resume and steer
  doors no longer claim records are cleared at session start; they point at
  `subagent_get` without `agent_id`.
- `src/config/default-agents.ts`: the orchestrator profile lists its workers
  with `subagent_get` after compaction, reload or a handoff.
- `README.md`, `docs/configuration.md`: document the records, the list, the
  record-backed reports and the card, and replace the note that a reload does
  not reconnect agent IDs.

## 2026-11-04: Agents run in the background by default; `foreground` replaces `run_in_background`

`subagent_start` returns an agent ID at once and announces the result with a
completion notification unless the call passes `foreground: true`, so a parent
can end its turn and stay available while agents work. The `run_in_background`
parameter and frontmatter key are removed, with no alias.

- `src/tools/agent-tool.ts`: the `foreground` parameter replaces
  `run_in_background`. A new agent and a resume both run in the background
  unless the call sets `foreground: true`; a resume still ignores the agent
  file's default. In print and json mode, where nothing can wake the parent
  after its turn, an omitted flag runs in the foreground. The tool guidelines
  tell the model to start its agents, end its turn and let the notification
  wake it, and to use `foreground: true` only when its next step needs the
  result.
- `src/config/invocation-config.ts`, `src/tools/spawn-config.ts`: `foreground`
  is the lockable field, and the merge takes the door's default (background
  unless a one-shot mode says otherwise). `resolveBackgroundMode` reads the
  agent's `foreground` frontmatter for service spawns, whose `foreground`
  option is unchanged.
- `src/types.ts`, `src/config/custom-agents.ts`: agent files declare
  `foreground: true|false`; `AgentConfig.foreground` replaces
  `runInBackground`. A `run_in_background` key, or a `locked` entry naming it,
  is no longer read.
- `src/ui/display.ts`: a foreground run is tagged `foreground`; background runs
  carry no tag. `src/ui/agents-browser.ts` shows a `Foreground` field.
  `src/main-agent-profile.ts` reports `foreground` among the skipped
  child-only fields.
- `src/tools/get-result-tool.ts`: `subagent_get`'s `wait` warns that it blocks
  the user too and points at the completion notification.
- `src/config/default-agents.ts`: the `orchestrator` profile stays available.
  It starts workers in the background, records their IDs, ends its turn, and
  never passes `foreground: true`, waits with `subagent_get` or polls. Run as a
  subagent, it collects its workers with `subagent_get` and `wait` before it
  finishes, because its run ends with its turn. It waits for a pull request's CI
  itself with `job_watch` and hands only the fixes to a worker in the PR's
  worktree. It no longer hands the waiting to a babysit-pr worker, because a
  subagent finishes when it ends its turn and its watch would wake no one.
- `README.md`, `docs/configuration.md`, `docs/architecture/architecture.md`:
  document the new default and flag.
- Tests: `test/tools/agent-tool.test.ts` covers the background default, the
  print/json fallback and the `foreground` flag for new agents and resumes;
  `test/ui/invocation-tags.test.ts` covers the tags;
  `test/config/agent-types.test.ts` asserts the orchestrator instructions. The
  other suites use the new field names.

## 2026-11-04: Orchestrator checks pull requests with git_pr_status

`src/config/default-agents.ts`: the built-in `orchestrator` profile records the
URL of a pull request a worker opens on its task, reads its state, review and
checks with pi-git's `git_pr_status` instead of `gh` or the GitHub MCP tools,
waits for CI with `job_watch` on `git_pr_status` (or hands the PR to a worker
with the babysit-pr skill), and completes the task and removes its worktree
once the PR is merged. After compaction or a reload it calls `git_pr_list`
beside `todo_list` and `git_worktree_list`. `test/config/agent-types.test.ts`
asserts the new instructions.

## 2026-11-03: Orchestrator runs implementation tasks in worktrees

`src/config/default-agents.ts`: the built-in `orchestrator` profile gives each
implementation task its own git worktree (`git_worktree_create`, one per
repository with a shared workspace when a task spans several) unless it is a
small change verified in place, passes it as `subagent_start`'s `cwd`, sends
the reviewer and follow-up workers to the same `cwd`, and removes it with
`git_worktree_remove` once its branch is merged or pushed. After compaction or
a reload it calls `git_worktree_list` beside `todo_list`. The profile already
had every parent tool through `all`; only its instructions changed.
`test/config/agent-types.test.ts` asserts the new instructions.

## 2026-11-03: pi-subagent-worktree removed from the bundle

The vendored `pi-subagent-worktree` companion was removed from the bundle; a
caller now prepares a directory and passes it as `cwd`. The `WorkspaceProvider`
seam is unchanged.

- `README.md`, `docs/architecture/architecture.md`,
  `docs/architecture/client-server-opportunities.md`,
  `docs/comparison-with-upstream.md`: worktree isolation is described as a
  caller-chosen `cwd` or a workspace provider, not a companion package.
- `src/service/service.ts`, `test/composition-root.test.ts`: comments name a
  workspace provider in general.

## 2026-11-03: Caller-chosen working directory

`subagent_start` takes an optional `cwd`: an existing directory, absolute or
relative to the parent's, that the child runs in. It lets an orchestrator hand a
worker a git worktree it created, in any repository, instead of relying on a
workspace provider chosen per agent type.

- `src/lifecycle/spawn-cwd.ts` (new): resolves and checks the path. A missing
  directory or a non-string is refused before anything is spawned.
- `src/tools/agent-tool.ts`: the `cwd` parameter and its guidance line; refused
  together with `resume`, since a resumed agent keeps its directory.
- `src/tools/spawn-config.ts`, `background-spawner.ts`, `foreground-runner.ts`,
  `src/lifecycle/subagent-manager.ts`: thread `cwd` like `handoff`.
- `src/lifecycle/subagent.ts`: with a `cwd`, `run()` skips the workspace provider,
  so nothing is disposed when the run ends and `resumeRefusal` never reports
  `workspace-disposed` for it.
- `src/service/service.ts`, `service-adapter.ts`: `SpawnOptions.cwd`, checked
  against the session's cwd; a bad one throws.
- `src/lifecycle/child-lifecycle.ts`, `create-subagent-session.ts`:
  `subagent:session:created` carries the child's effective `cwd`.
- Tests: `test/lifecycle/spawn-cwd.test.ts` (new), `test/cwd-sdk.test.ts` (new:
  a real orchestrator session spawns a worker with a relative `cwd` and resumes
  it), and cases in `subagent.test.ts`, `agent-tool.test.ts`,
  `service-adapter.test.ts`; `handoff-sdk.test.ts` expects the new `cwd` field.

## 2026-11-01: Questions through pi-ask (#62)

The `ask_parent` tool is gone. A child asks with the bundled pi-ask's `ask`,
which the core reaches through a session-tree service: before a child's
extensions bind, `createSubagentSession` offers the run's question recorder as
the child's `ask:route`, adds `ask` to the child's tool allowlist as protocol,
and withdraws the service when the child is disposed. The question still lands
on the record as `pendingQuestion`, and every result carrier still renders it
with the resume call that answers it.

## 2026-11-01: Identifiers (#59)

Every identifier follows this bundle's `resource:name` grammar, so session data
and process globals from upstream builds are not recognised. The directory and
package moved from `extensions/pi-subagents` (`@gotgenes/pi-subagents`) to
`extensions/pi-subagent` (`pi-subagent`).

- Events: `subagents:<event>` became `subagent:<event>` (created, started,
  resuming, resumed, completed, failed, compacted, steered), and
  `subagents:update` became `subagent:notified`. Child-session events
  `subagents:child:*` became `subagent:session:*` (`session-created` is now
  `subagent:session:created`). Settings events are `subagent:settings:loaded`
  and `subagent:settings:changed`.
- Session entries: `subagents:record` became `subagent:record`, and
  `pi-subagents:main-agent-profile` became `agent:profile`.
- Message types: `subagent-notification` became `subagent:completion`,
  `subagent-update` became `subagent:update`, `subagent-workspace-notice` became
  `subagent:workspace-notice`, and `subagents:turn-budget-warning` became
  `subagent:turn-budget-warning`.
- Global symbols: the upstream `@gotgenes/pi-subagents:service` slot is removed;
  publications live under `subagent:services`.
- Tools: `subagent` became `subagent_start`, `get_subagent_result` became
  `subagent_get`, `steer_subagent` became `subagent_steer`, and `notify_parent`
  became `parent_notify`.
- Commands: `/subagents:watch|settings|sessions` became `/subagent:*`, and
  `/subagents:agents` became `/agent`, since it browses agent definitions the
  main agent also uses through `--agent`.
- UI keys: widget `agents` became `subagent:widget`, the watch host
  `subagent-watch-host` became `subagent:watch`, status `subagents` became
  `subagent:status`, and status `main-agent` became `agent:status`.
- Settings file: `subagents.json` became `subagent.json`.

## 2026-10-31: Shared pi-ui (#51)

UI primitives now come from the bundle's `packages/pi-ui` library instead of
local copies:

- `src/ui/read-only-browser.ts` (the adapted `pi-system-insights` viewer) is
  removed. `/subagents:agents` builds an `ExplorerView` and opens it with
  `showExplorer`; details are structured blocks (fields, then Description, Tool
  guideline, Body, Fragments and Composed instructions sections). The regular
  renderer fallback is gone: pi-ui supports Pi's fullscreen TUI only.
- `src/ui/widget-renderer.ts` keeps ordering, linger, queued counts, budgets and
  the elapsed/prompt-mode width thresholds, and describes rows as a `WidgetView`
  for `renderWidget` (overflow groups `running`/`finished`). Status text is
  pre-clipped to 40% of the row as before.
- `src/ui/glyphs.ts`, `src/ui/labeled-rule.ts` and `src/ui/bounded-lines.ts` are
  removed in favor of pi-ui's `ICONS`/`SPINNER`, `labeledRule` and `BoundedLines`
  (renamed glyphs: `toolCall` → `tool`, `agentsHeading` → `agents`,
  `agentsActive` → `active`, `agentsIdle` → `idle`).
- `watchText` and the main-profile notice use pi-ui's `sanitizeText`; lone CR now
  becomes a line break, tabs expand to four spaces, and an incomplete CSI keeps
  its parameter bytes as plain text.
- `src/ui/watch-overlay.ts` owns its passive overlay through `PassiveOverlay`
  (non-capturing, own handle, hide on width change). Visibility, linger and
  repaint cadence are unchanged.
- The `/subagents:sessions` navigator, `/subagents:settings` dialogs and tool/
  notification renderers keep their own presentation.

## 2026-10-31: Remove standalone declaration bundling (#43)

- Dropped the TypeScript 7 / Rolldown declaration bundles added in #42 and the
  optional `build:types` script. Public API type exports reference TypeScript
  source directly; Pi loads that source without a declaration or JavaScript
  build.
- Companion extensions import this vendored source through a relative path,
  e.g. `../pi-subagent/src/service/service.ts`, rather than assuming the
  published `@gotgenes/pi-subagents` package is installed in a Git-installed
  bundle.

## 2026-10-31: Shared Oxc and TypeScript 7 tooling (#42)

- Apply the bundle's Oxfmt formatting and Oxlint correctness checks to source,
  tests, scripts, and documentation.
- Keep terminal-control matching explicit with narrowly scoped lint comments.
- Resolve private import aliases to explicit `.ts` files so sibling workspace
  consumers can load the service through standard package import resolution.
- Generate public declarations with TypeScript 7 and bundle them with Rolldown;
  no TypeScript 6 compiler API is required.

## 2026-10-31: Orchestrator todo handoff (#40)

- The orchestrator prompt (`src/config/default-agents.ts`) tells it to hand each
  worker its tasks with `handoff: { todos: { keys } }`, which pi-todo turns into a
  claim the worker updates directly. Its note that workers' todo edits never reach
  the ledger now covers only edits outside a handoff.
- `test/todo-handoff-sdk.test.ts`: a real orchestrator (pi-subagents + pi-todo)
  hands two tasks to a worker through the tool and checks the veto, the scoped list,
  attributed updates, a new task joining the claim, and the release.

## 2026-10-31: Spawn handoff and run identity on child events (#35)

- The `subagent` tool and `SpawnOptions` take a generic `handoff` object whose
  top-level keys belong to other extensions (pi-todo reads `todos`).
  `normalizeHandoff` (`src/lifecycle/child-lifecycle.ts`) only checks it is a JSON
  object within `MAX_HANDOFF_BYTES`, copies and deep-freezes it; the core forwards
  it untouched on `subagents:child:session-created`. New handoff data needs no
  change here.
- `subagents:child:session-created`, `bound` and `disposed` also carry `agentId`
  (the record id) and `toolCallId` (the parent's tool call; absent for service
  spawns), so a parent-side extension can tie a child session to the spawn.
- Tests: `test/handoff-sdk.test.ts` (a real orchestrator session spawning through
  the tool) plus unit tests in the lifecycle, tools and service suites.

## 2026-10-31: Companion typechecking (#33)

- `package.json` `imports`: each `#src/*` and `#test/*` target gained a `types`
  condition (`./src/*.ts`) beside the unchanged `default`, so a companion
  extension that imports this source by relative path (pi-subagent-worktree)
  can typecheck it without mapping `#src` itself. This package's own
  `tsconfig.json` paths and its runtime resolution are unchanged.

## 2026-10-31: Personal reviewer profile (#36)

- `src/config/default-agents.ts`: new built-in `reviewer` (read-only tools, inherited
  model, `replace` mode). It verifies finished work against its acceptance criteria,
  may run the project's checks, never edits files or git state, and starts its report
  with `Verdict: PASS`, `FAIL`, or `BLOCKED`, followed by per-criterion evidence.
- `AgentTypeRegistry.DEFAULT_AGENT_NAMES` lists it after Plan.
- The orchestrator prompt names reviewer for verification and gains one bullet:
  review each implementation task with a reviewer that did not do the work, resume
  the implementer on `FAIL`, and stop after two failed rounds.
- Tests: `test/config/agent-types.test.ts` (profile, tools, orchestrator wording,
  user override); fixture user agent `reviewer` renamed `linter` there, and the
  agents-browser lists now include the built-in.

## 2026-10-31: Latest-model defaults (#38)

- `src/session/model-resolver.ts`: a model string ending in `@latest`
  (`[provider/]family@latest`) resolves to the newest available model whose id
  contains `family`, comparing the numbers in the id (so `claude-haiku-5-5` beats
  `claude-haiku-4-5-20251001`). No match is an error string, so config-specified
  models fall back to the parent like any other unresolved model.
- `src/main-agent-profile.ts`: a `provider/…@latest` profile model goes through the
  resolver instead of exact lookup.
- Explore's default model is `anthropic/claude-haiku@latest` instead of the pinned
  `anthropic/claude-haiku-4-5-20251001`, so it follows new Haiku releases and does not
  silently fall back to the parent's model when an old one is retired.
- Docs: built-in table and the `model` frontmatter rows here and in the README.

## 2026-10-30: Service publication per session (#29)

- Upstream kept one `globalThis` slot. Each in-process child session loads the
  extension again, replaced the parent's service at load, and deleted the slot on
  shutdown, leaving the parent with no service until its next reload.
- `src/service/service.ts` now keeps every published service under
  `Symbol.for("subagent:services")` (see Identifiers), pending from the factory
  until `session_start`. The newest pending service is the default while a load
  is in progress (so companions such as pi-subagent-worktree still register
  their provider from their factory, in children too); otherwise the outermost
  started one is. The upstream single slot is gone (see Identifiers).
- A starting session drops older pending publications, and a child whose
  creation fails discards the ones its load made, so a load that never starts
  cannot stay the default. `unpublishSubagentsService(service)` removes only its
  own publication (the argument is now required).
- `getSubagentsService(sessionId?)` can return a specific session's service.
- Tests: `test/service/service.test.ts`, and parent/child, load-only,
  companion and failed-child cases in `test/composition-root.test.ts`.

## 2026-10-29: Personal pi-stash integration (#13)

- `READ_ONLY_TOOLS` in `src/config/default-agents.ts` gains `stash_get` and
  `stash_list`, so Explore and Plan can read `stash:<name>@<hash>` handles from the
  bundled `pi-stash` extension. Both tools only read.
- Explore's `toolNames` additionally include `stash_put` (not the shared list), so it
  can return large findings as a handle. `stash_put` writes only to Pi's data
  directory, never the project. Explore's read-only prompt names it as the single
  exception to "no files" and asks for large findings to be stashed.
- Plan stays read-only: `stash_get` and `stash_list` only.
- The orchestrator prompt gains one bullet: brief workers with stash handles for
  shared material and ask for large results as handles.
- Children load the parent's extensions, so the tools exist there when the bundle
  is installed; without pi-stash the extra names simply match no tool.
- `test/stash-sdk.test.ts` covers Explore writing and reading, and Plan being
  refused `stash_put`, in real SDK child sessions.

## 2026-10-29: Shared compiler and test config (#17)

- `vitest.config.ts`: dropped the `#src`/`#test` resolve aliases. Vite resolves
  the package.json `imports` map itself; `tsconfig.json` keeps its `paths`
  because TypeScript does not add file extensions to extensionless `imports`.
- Root `tsconfig.base.json` now also enables `verbatimModuleSyntax`,
  `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`,
  `noUnusedLocals`, and `noUnusedParameters`; this source needed no changes.

## 2026-10-29: Dev dependency pins (#12, #15)

- Pi dev dependencies bumped from 1.1.0 to 1.4.0 (2026-10-29).
- `typebox` dev dependency pinned to `1.3.27`, the exact version Pi 1.4.0 bundles,
  so tests exercise the schema library extensions receive at runtime.
- `engines.node` raised from `>=22` to `>=24` and `@types/node` to `^24`, matching
  the bundle's supported Node.js version.
- `vitest` dev dependency raised from `^4.1.11` to `^5.0.5`; no test changes needed.
- `test/ui/read-only-browser.test.ts` (since removed by the shared pi-ui entry): the
  `plain()` helper also stripped Pi's fake-cursor markers. pi-tui 1.4.0's `Input`
  wraps its cursor cell in zero-width APC markers that the TUI resolves to the
  same reverse video 1.1.0 emitted directly, so the rendered output is unchanged.

## 2026-10-22: Personal prompt fragments

- Added `fragments: [name, ...]` to custom agent definitions.
- Resolve names only in the winning profile's `agents/fragments/<name>.md`;
  plain Markdown fragments precede the profile body in declaration order.
- Main and child profiles share composition; selected execution retains expanded
  text across resume and background queueing.
- Discovery stays lazy, project fragment reads require trust, and invalid/missing
  references fail selected execution rather than dropping instructions.
- Read-only `/subagents:agents` details show fragment sources and composition.

## 2026-10-22: Personal profile UX

- Added `/subagents:agents`: searchable read-only definitions, disabled status,
  effective fields/source paths/locks, description, then full-width Body content.
- Adapted the `pi-system-insights` viewer locally to keep standalone installs
  independent: padded rounded frame, contextual help, bounded regular screen,
  centered fullscreen overlay, keyboard navigation and fullscreen wheel scrolling.
- Added `--agent <profile>` for the initial main session only. Applies profile
  model/thinking/tools as defaults, preserves manual choices on resume/reload,
  and restores the exact saved profile body as system instructions.
- Added main-only `--agent-model <model>` for explicit initial `--agent` selection.
  Overrides the effective snapshot's model default without mutating definitions,
  reapplying on restoration, or forwarding a child override. Launchers pair it
  with core `--model` because native `getFlag` cannot read core CLI flags.
- Main MCP wildcards expand only to non-hidden tools available at startup; empty
  matches are reported in the startup notice, not treated as missing required
  tools. MCP connects asynchronously. Literal missing/hidden tools still block.
- Main profile selection requires project trust for project definitions and keeps
  delegation tools available. Child behavior is unchanged; main profile body is
  excluded from both full and portable child prompt inheritance.

## 2026-10-22: Personal watch overlay

- Added fullscreen-only `/subagents:watch` and `Ctrl+Alt+S`, with a passive right
  overlay showing always-tailing background-agent text and compact tool activity.
- Added persisted width presets (`quarter`, `third`, `half`, `two-thirds`),
  default visibility (closed), and thinking visibility (shown). Explicit session
  visibility overrides the open/closed default.
- Feed entries retain provider-emitted thinking, with themed Think / Tool / Skill
  labels and error coloring; thinking visibility changes update live overlays.
- Agents still execute in-process. Internal session-ready observer wiring allows
  live subscription before the first child event without widening the public API.
- Output buffers and repaint cadence are bounded; no transcript scrolling or
  inherited context is shown. Session shutdown/replacement releases subscriptions,
  timers, and only the overlay this fork owns.
- Regular mode remains overlay-free: Pi 1.1.0 still exhibits the scrollback defect
  documented in ADR 0007, including with one- or two-row top margins on bursts.

## 2026-10-22: Personal widget changes

- Replaced the two-line running-agent tree with a static `── ● Subagents ──`
  header rule and one line per agent. No enclosing box or bottom border.
- Layout inspired by `maplezzk/pi-extensions/packages/pi-interactive-subagents`,
  but implemented locally using Pi themes and terminal-cell width utilities.
- Elapsed time and agent type/task on the left; activity or outcome on the right.
  Model/token/turn stats remain in tool results, not the widget.
- Queued agents have individual rows and no ticking elapsed clock. Existing
  background-only filtering, completion linger, animation cadence, and viewport
  safeguards remain unchanged. Running/queued/finished order determines priority.
- Rendering honors the width passed by Pi, rather than always using terminal width.
- Agent rows now reserve one space at each edge, before elapsed time and after
  activity/outcome; header remains full-width.
- Renderer tests cover the single-line layout, static header, ANSI/Unicode,
  edge spacing, narrow screens, queued/finished outcomes, and exact overflow counts.

## 2026-10-22: Integration

- Marked package private and removed publication configuration.
- Replaced monorepo `catalog:` dev dependency versions with normal versions.
- Aligned Pi dev dependencies with installed Pi 1.1.0; host runtime peers use `*`.
- Removed lint commands requiring upstream monorepo configuration and removed the
  published-tarball verification command from the manifest. Its original script
  remains as reference, not part of local verification.
- Kept `#src/*` and `#test/*` import aliases and the original source layout.
- Root private npm workspace supplies a single development install and commands.
- Copied upstream shared TypeScript compiler settings to root `tsconfig.base.json`.
- Added a local-install notice to the upstream README.
- Adapted tests for Pi 1.1: added `Terminal.setProgramStatus` to the terminal stub,
  fixed viewport keybindings explicitly, and disabled Git commit signing only in
  the temporary-repository fixture (no personal Git settings changed).

No upstream runtime behavior was intentionally changed during import.

## 2026-10-22: Vendored

Imported from upstream; see [UPSTREAM.md](UPSTREAM.md). Upstream's changelog was
cleared at import; for earlier history see the
[source changelog](https://github.com/gotgenes/pi-packages/blob/29bfbfe605d726c78f6120977b08666716e048f2/packages/pi-subagents/CHANGELOG.md).
