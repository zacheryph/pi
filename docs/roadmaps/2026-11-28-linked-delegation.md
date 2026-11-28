# One-call delegation with linked tasks

Status: chosen · Updated: 2026-11-28

## Goal brief

**Stated request:** Give pi-todo tasks structured links (agent, worktree, pull
request) and let `subagent_start`'s handoff provision pi-git worktrees the way it
already hands over pi-todo tasks. Retire a clean worktree on its own once its
linked pull request merges.

**True goal:** Delegating one task end to end (isolate it, implement, review,
open a pull request, merge, clean up) is one spawn per worker, and the system,
not the model, keeps track of which agent, worktree and pull request belong to
which task. A task's history then holds only what a person wants to read:
findings, blockers and outcomes.

**Consumers:**

- The orchestrating model (the orchestrate profile, the execute-roadmap skill,
  ad-hoc parallel delegation): fewer calls per step, nothing to copy between
  calls, one place to recover state after compaction, reload or
  `/subagent:switch`.
- You, in `/todo`, the todo widget, the dashboard and bb: each task row shows its
  live agent, its worktree and its pull request, with a link.

**Success criteria:**

- One `subagent_start` call creates (or reuses) a task's worktree and runs the
  agent in it. No `git_worktree_create` call and no `cwd` copied from one call
  to the next.
- A review or repair agent for the same task lands in the same worktree by
  naming the same branch.
- Every task row shows the task's agent, worktree and pull request with their
  current state, in the TUI and in every `pi-surface` renderer, and the hidden
  todo note after compaction carries the same links.
- The orchestrate profile and execute-roadmap tell the model to write no stage,
  agent ID, worktree path, branch or pull request URL into a task's `message`.
- A worktree whose linked pull request merged and that holds nothing at risk is
  removed without a model call; its branch is kept.
- `extensions/pi-subagent/agents/orchestrate.md` and
  `skills/execute-roadmap/SKILL.md` lose their worktree and stage bookkeeping
  rules (today about 25 of execute-roadmap's 316 lines).

**Non-goals:** Changing Pi core or bb core. Making pi-subagent's core read any
handoff key. Merging, approving or reverting pull requests (still the user's).
Removing `git_worktree_create`: it stays for worktrees made without a spawn.
Handing tasks on from a delegated orchestrator (`delegation.ts:370`).

**Constraints:** `AGENTS.md` runtime rules: closure state; persist with
`pi.appendEntry` and replay; no per-request `context` messages; `pi-surface` for
what other UIs show; packages never import extensions. Removing a worktree must
never lose uncommitted or unbranched work (`atRisk`, `worktrees.ts:189`).

**Open to change:** pi-git, pi-todo, pi-subagent's tool guidance, the
orchestrate profile, the execute-roadmap and babysit-pr skills, the bb plugin's
todo tables, a shared package for a new contract. / **Off limits:** Pi and bb
core (not ours); the shape of `handoff.todo` (other callers rely on it).

**Appetite:** leave it better (the request asks for lasting structure, not the
smallest change).

**Facts established from the repo:**

- The handoff is a generic, frozen JSON bag forwarded to `prepare` and
  `session-created`; the core never reads it
  (`extensions/pi-subagent/src/lifecycle/child-lifecycle.ts:58`).
- pi-todo validates `handoff.todo` in a `tool_call` handler and binds claims on
  `subagent:session:created` (`extensions/pi-todo/src/delegation.ts:363`, `:383`).
- Pi lets a `tool_call` handler change a call's arguments by mutating
  `event.input` in place, and awaits async handlers
  (`@earendil-works/pi-coding-agent` `core/extensions/types.d.ts:1110`).
- `subagent_start` resolves `cwd` inside `execute`, after every `tool_call`
  handler has run (`extensions/pi-subagent/src/tools/agent-tool.ts:83`).
- pi-git already records which agents ran in which worktree from
  `subagent:session:created`'s `cwd` (`extensions/pi-git/src/index.ts:549`).
- pi-git knows each pull request's head branch (`extensions/pi-git/src/prs.ts:43`)
  and each worktree's branch (`extensions/pi-git/src/ledger.ts:27`), but never
  joins them.
- A child's pi-git hands its records to the parent's through the session tree
  (`extensions/pi-git/src/index.ts:135`), so a pull request a worker opens
  reaches the parent's ledger.
- After a compaction pi-todo sends a hidden note with the whole list
  (`extensions/pi-todo/src/index.ts:884`).

## Answers

| #   | Question                                                          | Recommended   | Answer                                          | Source                                            | Status   |
| --- | ----------------------------------------------------------------- | ------------- | ----------------------------------------------- | ------------------------------------------------- | -------- |
| 1   | Can an extension change a tool call's arguments before it runs?   | —             | Yes: mutate `event.input` in a `tool_call` hook | `pi-coding-agent` `extensions/types.d.ts:1110`    | resolved |
| 2   | Does anything join a pull request to the worktree it came from?   | —             | No; both sides hold the branch                  | `pi-git/src/prs.ts:43`, `pi-git/src/ledger.ts:27` | resolved |
| 3   | Is task → agent kept after the agent ends?                        | —             | Only in memory and in claim journal ops         | `pi-todo/src/delegation.ts:247`                   | resolved |
| 4   | Retire merged worktrees by default, or behind an opt-in setting?  | Default on    | Default on                                      | user                                              | resolved |
| 5   | Retire a merged worktree while a kept (resumable) agent is in it? | Yes, if clean | Wait for no running agent                       | user                                              | resolved |

## Inputs

| Input                                         | Consumer                                   | Today's source                                                                                | Producer / owner    | Problem                                             | Recommended supply                                                                                    |
| --------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Worktree spec (repo, branch, base, workspace) | pi-git, at spawn                           | Caller passes it to `git_worktree_create` in a turn of its own                                | Orchestrating model | An extra round trip; the result is copied by hand   | Caller passes it as `handoff.worktree` on `subagent_start` (rung 2, on the existing handoff contract) |
| The child's `cwd`                             | pi-subagent                                | Copied from `git_worktree_create`'s result (`agent-tool.ts:83`)                               | pi-git              | Paths travel through prose                          | pi-git sets `event.input.cwd` in its `tool_call` hook                                                 |
| The worktree a branch already has             | pi-git, for review and repair agents       | The model passes the same `cwd` again                                                         | pi-git ledger       | The model must remember the path                    | pi-git reuses the live record for the same repository and branch                                      |
| Task → agent                                  | pi-todo rows and links                     | Claims (`delegation.ts:396`), dropped on release; prose `implementing (agent <id>)`           | pi-todo             | Lost when the agent ends                            | pi-todo keeps every agent that held a task, rebuilt from its claim journal                            |
| Agent → worktree, worktree → pull request     | pi-todo rows, the restore note, retirement | `record.agents` (`index.ts:549`); no join to pull requests                                    | pi-git              | Visible only in git views; URL copied into messages | pi-git advertises links keyed by agent ID (contract below)                                            |
| Live state of each link                       | Task rows in `/todo`, bb, dashboard        | Each extension's own view                                                                     | Each producer       | Four places to reconcile                            | Carried on the link, re-advertised when it changes                                                    |
| Merge signal                                  | Worktree retirement                        | `git_pr_watch` reports `Merged.` (`watch.ts:211`); the model then calls `git_worktree_remove` | pi-git              | Forgotten at the end of long runs                   | pi-git acts on its own merged observation                                                             |

**Contract: `handoff.worktree`** (owner pi-git; read in pi-git's `tool_call` hook)

- Shape: `{ branch: string, base?: string, repo?: string, workspace?: string }`,
  the same fields and meanings as `git_worktree_create`.
- Meaning: run this agent in that worktree; create it if this session has no
  live one for that repository and branch, reuse it if it does.
- Conflicts: a `cwd` that is not the provisioned path blocks the call with a
  reason naming both. A failed create blocks the call with the git error.
- A call blocked later by another extension leaves the worktree in place; the
  next spawn for the branch reuses it, so nothing is orphaned.

**Contract: task links** (owner: a small shared module in `packages/`, home to
settle in step 4; producers pi-git, later pi-job or others; consumer pi-todo)

- Channel on the session's event bus, versioned payload
  `{ version: 1, agent, kind, id, label, url?, state?, at }`. `agent` is the
  pi-subagent agent ID, the one identity every side already shares; `kind` is
  `worktree` or `pr` today, and unknown kinds render generically; `url` is
  `https:` only; `state` is one short line (`clean`, `2 unpushed`, `checks
  failing`, `merged`).
- Meaning: the producer promises this item is part of the work agent `agent`
  does. Neither side holds the other's identifiers: pi-git never learns task
  keys, pi-todo never learns git paths.
- Consumer: pi-todo attaches the link to every task that agent holds or held,
  journals it (`pi.appendEntry`) so it survives replay without the producer, and
  keeps the newest state per `(kind, id)`.
- Absent: no link shown; nothing falls back to prose.
- Retrofit: pi-git announces on worktree binding, pull request join and every
  state change it already records.

## What exists

**Prior art:**

- The handoff slot and its `tool_call` + `session:created` pattern, proven by
  pi-todo (`delegation.ts:352-410`).
- `createWorktree` is already a plain function the tool wraps
  (`pi-git/src/index.ts:878`); `atRisk` and `removeWorktree` exist
  (`worktrees.ts:189`, `:217`).
- pi-git's agent binding from `cwd` (`index.ts:549`) and child-to-parent record
  adoption (`index.ts:135`).
- pi-todo already shows a delegated task's holder (`surface.ts:11`) and sends a
  hidden whole-list note after compaction (`index.ts:884`).
- Scenario tests for both halves: `test/scenarios/git-worktree.test.ts`,
  `test/scenarios/todo-delegation.test.ts`.

**Conventions to follow:** Each handoff key is validated and documented by its
owner, in its own tool guidance. Settings through `defineSettings`. State
changes reach the model as one hidden `triggerTurn: false` note. New views and
actions through `pi-surface`; the bb plugin's per-view tables follow the
`surface-view` skill. Cross-extension behaviour gets a scenario in `test/`.

**Friction:**

| Friction                                                                               | Evidence (`file:line`)                                                                 | Blocks                                        | Fix cost | Verdict                                                            |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------- | -------- | ------------------------------------------------------------------ |
| Worktree creation and its ledger append live inside the tool's `execute`               | `pi-git/src/index.ts:876-905`                                                          | Provisioning from a hook                      | S        | Fix first: extract one `provision` used by both                    |
| Creating a branch that already has a worktree fails instead of reusing it              | `pi-git/src/worktrees.ts:79-94`                                                        | Review and repair agents in the same worktree | S        | Fix first: look up the live ledger record by repository and branch |
| Pull requests and worktrees are never joined                                           | `pi-git/src/prs.ts:43`, `pi-git/src/ledger.ts:27`                                      | PR links, retirement                          | S        | Fix first                                                          |
| Task → agent is lost when a claim is released                                          | `pi-todo/src/delegation.ts:247`, `:283`                                                | Links for tasks whose agent ended             | S–M      | Fix first: keep holders per task, replayed from claim ops          |
| No contract for one extension to annotate another's records                            | — (missing seam)                                                                       | Links on task rows                            | M        | Fix first (the contract above)                                     |
| The skills use task messages as a scratchpad for stage, agent ID, path, branch and URL | `skills/execute-roadmap/SKILL.md` §1–2, §5; `orchestrate.md` "Delegate and coordinate" | The noise the change removes                  | M        | Fix as the change itself                                           |
| Retirement relies on the model calling `git_worktree_remove`                           | `skills/execute-roadmap/SKILL.md` "After the merge" 1                                  | Retirement                                    | S        | Fix first (pi-git acts on merged)                                  |
| pi-git does not know whether an agent bound to a worktree is still running             | `pi-git/src/index.ts:549` records ids only                                             | Safe retirement                               | S        | Work around: retire only when `atRisk` is clear; see answer 6      |
| If pi-todo blocks a spawn after pi-git created its worktree, the worktree stays        | `tool_call` handler order is load order                                                | Clean failure                                 | —        | Work around: reuse by branch makes the next try pick it up         |

**Noticed, not doing:** A delegated orchestrator cannot hand tasks on
(`pi-todo/src/delegation.ts:370`). `git_worktree_create` could accept a task
key as its branch by default.

**Not examined:** The bb plugin's todo stack card code, beyond knowing it
renders pi-todo's surface views (step detail will cover it). pi-job as a second
link producer.

## Options

### Option A: Baseline — worktrees at spawn, prose for the rest

**Idea:** Add `handoff.worktree` (create or reuse) and retirement on merge to
pi-git, and rewrite the skills around them. Tasks get no links: the PR URL and
any stage still go into `message`.
**Steps:** 1. extract `provision` → 2. reuse by branch → 3. `handoff.worktree`
→ 4. join PR to worktree, retire on merge → 5. rewrite the skills.
**What it makes easy:** The round trip and the copied `cwd` go away; nothing
forgets a worktree.
**What it leaves behind:** Messages still carry URLs and stage; after
compaction the model still reconciles the todo note, the subagent roster card
and the git card.
**Cost:** S–M, all in pi-git and the skills.
**Risk and reversibility:** Low; each step is one pi-git change and reverts alone.
**Value timing:** Step 3 ships the one-call spawn.
**Choose it when:** The round trip is the real pain and task rows are fine as they are.

### Option B: Seam first — advertised links, joined by agent (recommended)

**Idea:** Option A, plus the task-links contract: pi-git advertises what each
agent's work produced (its worktree, its pull request, their state), and
pi-todo attaches those links to the tasks the agent held, shows them on every
row and in its restore note. Nobody writes identifiers into messages.
**Steps:** 1. extract `provision` → 2. reuse by branch → 3. `handoff.worktree`
→ 4. links contract module → 5. pi-todo keeps task holders → 6. pi-todo stores
and shows links (TUI, surface views, restore note) → 7. pi-git advertises
worktree links → 8. join PR to worktree, advertise PR links → 9. retire merged
worktrees → 10. bb plugin task rows → 11. rewrite orchestrate and the skills.
**What it makes easy:** Every input above. A new producer (pi-job, a deploy
check) can add a link with no pi-todo change.
**What it leaves behind:** One small contract to own; links are as current as
their producer's last announcement.
**Cost:** M–L, concentrated in pi-todo (steps 5–6).
**Risk and reversibility:** Medium: a new journal entry type in pi-todo. Each
step reverts alone; links are additive and render nothing when absent.
**Value timing:** Step 3 ships the one-call spawn; step 8 puts PR links on rows;
step 11 removes the ceremony.
**Choose it when:** You want task rows and the restore note to be the single
place state lives, and expect more producers.

### Option C: Typed `refs` on tasks, written by the model and by pi-git

**Idea:** Option A, plus `refs?: { agentId?, worktree?, branch?, pr? }` on
`TodoTask`, settable through `todo_upsert` and by pi-git, which reads the task
keys from `handoff.todo` on the same spawn and writes through a pi-todo event.
**Steps:** 1–3 as A → 4. `refs` in pi-todo's schema, journal and views → 5.
pi-git reads `handoff.todo.keys` and writes `worktree`/`branch` → 6. pi-git
writes `pr` → 7. retire on merge → 8. rewrite the skills.
**What it makes easy:** A literal, fixed field set; the model can fix a ref by hand.
**What it leaves behind:** pi-todo's schema names git concepts; pi-git reads
pi-todo's handoff shape; refs drift unless pi-git also writes state, at which
point it is Option B with fixed keys. The model is invited to write refs, which
is the prose habit in a new field.
**Cost:** M.
**Risk and reversibility:** Medium; a schema change in pi-todo is harder to
take back than an additive link entry.
**Value timing:** Same as B.
**Choose it when:** pi-git will stay the only producer and model-written refs matter.

### Compare

|                                | A                 | B                | C                       |
| ------------------------------ | ----------------- | ---------------- | ----------------------- |
| Effort                         | S–M               | M–L              | M                       |
| Effort before first value      | Steps 1–3         | Steps 1–3        | Steps 1–3               |
| Removes prose bookkeeping      | Partly (no paths) | Fully            | Mostly                  |
| Restore after compaction       | Three cards still | One todo note    | One todo note           |
| Coupling                       | None new          | Agent ID only    | pi-git ↔ pi-todo shapes |
| Next producer (pi-job, deploy) | Prose             | Announces a link | Schema change           |

### Recommendation

**Option B.** The goal is that the system, not the model, holds the task →
agent → worktree → pull request mapping, and the appetite is to leave the area
better. B is the only option where that mapping lives in one place without
pi-todo or pi-git learning each other's identifiers, and its first three steps
are Option A's, so the one-call spawn ships before any contract work.
Choose A instead if links on rows turn out not to matter once the round trip
is gone; choose C if model-written refs are a requirement.

## Decision

**Option B**, chosen by the user on 2026-11-28, as recommended. Retirement is
on by default behind a setting (answer 4) and waits until no agent bound to the
worktree is running (answer 5), which adds step 10.

## Roadmap

Start with step 1; it is safe to start today. Steps 1–3 ship the one-call
spawn on their own, before any contract work.

### Make it easy

### 1. Extract worktree provisioning from `git_worktree_create`

**Type:** tidy (behavior-preserving)
**Eases:** steps 2 and 3 (friction: creation and its ledger append live inside the tool)
**Does:** Move `createWorktree` + `append(record)` + the "from" text out of the
tool's `execute` (`extensions/pi-git/src/index.ts:876-905`) into one closure
function, `provision(request, ctx, signal)`, that returns the record. The tool
calls it.
**Done when:** `git_worktree_create` behaves exactly as before and the tool body
is a call to `provision` plus its result text.
**Verification:** `npm run test:workspace -- pi-git` unchanged and green;
`test/scenarios/git-worktree.test.ts` green.
**Ships alone:** yes · **Rollback:** revert the commit
**Depends on:** — · **Size:** S

### 2. Reuse a branch's live worktree instead of failing

**Type:** the change (pi-git behavior)
**Eases:** step 3, and review or repair agents reaching the same worktree
**Does:** Before creating, `provision` looks up a ledger record that is not
`removed` for the same repository and branch (and workspace, when given) whose
path still exists, and returns it marked `reused`. A `base` that disagrees with
the record's base is an error naming both. `git_worktree_create` says
"Reusing worktree …" for a reused one.
**Done when:** Creating the same branch twice returns the same path and writes
no second ledger record; a removed or deleted worktree is created afresh.
**Verification:** pi-git unit tests for reuse, removed and missing records, and
a disagreeing `base`; `npm run check`.
**Ships alone:** yes · **Rollback:** revert; the tool fails on a second create again
**Depends on:** 1 · **Size:** S

### 3. Provision a worktree from `subagent_start`'s `handoff.worktree`

**Type:** contract
**Eases:** step 12 (no `git_worktree_create` turn, no copied `cwd`)
**Does:** pi-git registers a `tool_call` hook for `subagent_start`. When
`input.handoff.worktree` is present it validates
`{ branch, base?, repo?, workspace? }`, calls `provision` (step 2), and sets
`event.input.cwd` to the worktree (or its workspace directory). A `cwd` that is
already set and differs blocks the call with both paths; a failed provision
blocks it with the git error. pi-git's tool guidance documents the key and that
a later agent naming the same branch lands in the same worktree. The agent is
bound to the record by the existing `subagent:session:created` handler
(`index.ts:549`).
**Seam or contract:** `handoff.worktree` (see Inputs); relies on Pi's
documented in-place `event.input` mutation and on `cwd` being resolved inside
`execute` (`agent-tool.ts:83`).
**Done when:** One `subagent_start` with `handoff: { todo: { keys: ["a"] },
worktree: { branch: "a" } }` runs the agent on branch `a` in a new worktree,
the todo claim binds as before, and a second spawn naming branch `a` runs in
the same path.
**Verification:** pi-git unit tests for the hook (valid, invalid, `cwd`
conflict, provision failure); a new bundle scenario,
`test/scenarios/worktree-handoff.test.ts`, covering create, reuse and the
pi-todo claim together; `npm run verify:bundle`.
**Ships alone:** yes · **Rollback:** revert; callers fall back to `git_worktree_create` + `cwd`
**Depends on:** 2 · **Size:** M

### 4. Define the task-links contract in a shared package

**Type:** contract
**Eases:** steps 6, 7 and 8
**Does:** Add a small module (channel name, `TaskLink` type, `announceLink(pi,
link)`, `readLink(value)` validator with the size caps and `https:`-only URLs)
to the package that already owns cross-extension session vocabulary. Read
`pi-foundations` and `pi-session-tree` first and pick the one whose README
already describes shared contracts; record the choice here. Document it in that
package's README with a code sample.
**Seam or contract:** task links (see Inputs).
**Done when:** The module and its validator exist with tests for valid, oversized,
non-`https:` and unknown-kind links; nothing produces or consumes yet.
**Verification:** that package's tests; `npm run check`; `npm run verify:bundle`
(package boundary).
**Ships alone:** yes · **Rollback:** revert
**Depends on:** — · **Size:** S

### 5. Keep every agent that held a task

**Type:** tidy (behavior-preserving)
**Eases:** step 6 (friction: task → agent is dropped on release)
**Does:** pi-todo derives `holders: Map<taskKey, agentId[]>` from its claim
journal ops during replay and as claims are made, instead of keeping only the
last ended claim in memory (`delegation.ts:247`). Nothing shown changes yet.
**Done when:** After an agent ends, and after a reload, the holders of its tasks
still list it.
**Verification:** pi-todo replay tests across claim, release, reload and `/tree`;
`npm run test:workspace -- pi-todo`.
**Ships alone:** yes · **Rollback:** revert
**Depends on:** — · **Size:** S

### 6. Show links on pi-todo's tasks

**Type:** the change (pi-todo behavior)
**Eases:** steps 9 and 12; delivers the "rows show agent, worktree, PR" criterion
**Does:** pi-todo listens on the task-links channel and journals each link
keyed by agent (newest state per `kind` + `id`) with `pi.appendEntry`, so
announcement order against the claim does not matter. A task's links are the
links of its holders (step 5), joined at render. Show them: one compact line
per task in the widget and `/todo` list (agent state, worktree branch and
state, `PR #n` and state), full rows with URLs in the task detail
(`todoTaskDetail`), as structured fields on pi-todo's surface views, and in the
hidden note sent after a change or compaction (`index.ts:884`). Also show the
holder's live agent state, which pi-todo already hears
(`subagent:completed` / `subagent:failed`).
**Done when:** A link announced for an agent appears on every task it held, in
the TUI, the surface views and the compaction note, and survives a reload with
no producer running.
**Verification:** pi-todo unit and rendering tests (narrow widths, ANSI and wide
Unicode, per the TUI spacing rule); `npm run test:workspace -- pi-todo`;
regenerate pi-todo's README images with the `tui-screenshot` skill.
**Ships alone:** yes (renders nothing until a producer announces) · **Rollback:** revert; journaled link entries are ignored
**Depends on:** 4, 5 · **Size:** M

### 7. Announce worktree links from pi-git

**Type:** contract (retrofit producer)
**Eases:** step 12
**Does:** When pi-git binds an agent to a worktree (`index.ts:549`) and whenever
it re-measures that worktree's status, it announces `{ kind: "worktree", id:
path, label: branch, state }` for each bound agent.
**Done when:** A task handed to an agent in a worktree shows that worktree and
its status on its row; the status updates after `/git:refresh`.
**Verification:** pi-git unit tests; extend `test/scenarios/worktree-handoff.test.ts`
to assert the link on the task.
**Ships alone:** yes · **Rollback:** revert
**Depends on:** 3, 6 · **Size:** S

### 8. Join pull requests to worktrees and announce PR links

**Type:** the change (pi-git behavior)
**Eases:** steps 11 and 12 (friction: pull requests and worktrees are never joined)
**Does:** A pull request record whose repository and `headRef` match a live
worktree record is joined to it, including records adopted from a child
(`index.ts:135`). For each agent bound to that worktree pi-git announces
`{ kind: "pr", id: key, label: "PR #n", url, state }`, and again whenever the
record's state changes (checks, review requested, merged, closed).
`git_worktree_list` and the `/git:worktrees` view show the joined pull request.
**Done when:** A worker that opens a pull request from its worktree makes
`PR #n` appear on its task with the current check state, and `Merged` once merged.
**Verification:** pi-git unit tests for the join (own and adopted records, no
match, two worktrees on one branch); extend `test/scenarios/pr-watch.test.ts`
or the new scenario with a faked `gh`.
**Ships alone:** yes · **Rollback:** revert
**Depends on:** 7 · **Size:** M

### 9. Show task links in bb's Todos card

**Type:** the change (bb plugin)
**Eases:** the "every renderer" success criterion
**Does:** The bb plugin's todo rows render step 6's link fields: PR as a link,
worktree branch and state, agent state, inside bb's 12px inset. The dashboard
picks them up from the surface view with no change; check it does.
**Done when:** A task with links shows them in bb and the dashboard.
**Verification:** in `bb-plugin/`, `npm run typecheck` and `npm test`;
`bb-shot.mjs --expand --check` passes (`bb-screenshot` skill); a dashboard check
by eye.
**Ships alone:** yes · **Rollback:** revert
**Depends on:** 6 · **Size:** S

### 10. Track which agents are running in each worktree

**Type:** tidy (behavior-preserving)
**Eases:** step 11 (answer 5: retirement waits for no running agent)
**Does:** pi-git keeps, in its closure, the set of bound agents whose run has
started and not yet ended (`subagent:session:created` in,
`subagent:completed` / `subagent:failed` / `subagent:session:disposed` out),
rebuilt as empty on `session_start` since a reload re-creates any agent it
reopens. Nothing acts on it yet.
**Done when:** Unit tests show a worktree's running set across start, finish,
failure, resume with `subagent_send`, and reload.
**Verification:** `npm run test:workspace -- pi-git`.
**Ships alone:** yes · **Rollback:** revert
**Depends on:** — · **Size:** S

### 11. Retire a worktree when its linked pull request merges

**Type:** the change (pi-git behavior)
**Eases:** step 12 (no `git_worktree_remove` rule in the skills)
**Does:** A new pi-git setting, `retireMergedWorktrees` (default `true`,
declared with `defineSettings`). When pi-git records that a joined pull
request merged (a watch, `git_pr_status`, `/git:refresh`), it marks the
worktree `retire` in its ledger. A worktree marked `retire` is removed with
`removeWorktree` (branch kept) as soon as no agent bound to it is running
(step 10) and `atRisk` is clear; it is re-checked when an agent ends and on
`session_start`. Uncommitted or unbranched work keeps it and says why in the
worktree's state. Each removal writes one hidden `triggerTurn: false` note and
updates the worktree link to `removed`.
**Done when:** A merged, clean worktree with no running agent is gone without a
model call; one with a running agent goes when that agent ends; a dirty one
stays with the reason shown; the setting turns it all off.
**Verification:** pi-git unit tests for each case and for a reload between
merge and removal; a bundle scenario for merge → retire with a faked `gh`.
**Ships alone:** yes · **Rollback:** set `retireMergedWorktrees: false`, or revert
**Depends on:** 8, 10 · **Size:** M

### The change

### 12. Delegate in one call and keep coordination out of task messages

**Type:** the change (agent profiles and skills)
**Does:**

- `skills/execute-roadmap/SKILL.md`: §2 starts each worker with one
  `subagent_start` carrying `handoff: { todo: { keys: [key] }, worktree: {
  branch: key, base } }` and sends the reviewer and repair rounds to the same
  branch. Drop the stage-as-`message` rule and the "record the agent ID / path /
  branch / URL" lines: the task's links show them. §5 "After the merge" loses
  `git_worktree_remove`. §7 resume reads the todo note's links instead of
  joining `git_worktree_list`, `git_pr_list` and the roster.
- `extensions/pi-subagent/agents/orchestrate.md`: the worktree bullet becomes
  `handoff.worktree`; drop "record each returned agent ID on its todo", "record
  the worktree path and branch", "record its URL on the task"; recovery after
  compaction starts from the todo note.
- `skills/babysit-pr/SKILL.md` and pi-git's and pi-subagent's tool guidance:
  name `handoff.worktree` where they name `git_worktree_create` + `cwd`.
- `message` stays for findings, blockers and outcomes, and says so.

**Done when:** Neither profile nor skill tells the model to write a stage,
agent ID, path, branch or pull request URL into a task message, or to remove a
merged worktree; the execute-roadmap worktree and stage rules are gone.
**Verification:** `npm run verify:bundle`; `npm run check`; a `tui-screenshot`
scenario that runs one roadmap step through implement → review → PR → merge on
the scripted model and shows the task row with its links and no stage messages.
**Ships alone:** yes · **Rollback:** revert the text
**Depends on:** 3, 8, 11 · **Size:** M

### Clean up

### 13. Update the READMEs and the bundle map

**Type:** cleanup
**Does:** pi-git's and pi-todo's READMEs show `handoff.worktree`, links on task
rows and retirement in their At a glance lists; the root README's "Who imports
what" table and diagrams add the task-links module; regenerate the images whose
content changed (`docs-images.mjs`).
**Done when:** No README describes `git_worktree_create` + `cwd` as the way to
delegate, or omits the new links.
**Verification:** `npm run check`; images regenerated.
**Ships alone:** yes · **Rollback:** revert
**Depends on:** 12 · **Size:** S

## Open questions

- Home of the task-links module (`pi-foundations` or `pi-session-tree`):
  settled in step 4 by what each package's README already owns.
- Not verified: that `subagent:session:created` fires again when
  `subagent_send` reopens an idle agent, which step 10 relies on to see a
  resumed run as running. Check it at the start of step 10.
