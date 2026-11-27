# Tasks that wait on you, and an end to review flags

Status: chosen · Updated: 2026-11-27

Follows [the attention queue](2026-11-26-attention.md) and replaces its step 10. The
attention item contract, the `git.attention` producer and the bb Attention
page that this plan builds on landed there.

## Goal brief

**Stated request:** Add a status to pi-todo for a task that waits on the user,
and show those tasks as attention items. Remove todo review tracking
completely. Update the orchestrate agent and the skills to use the new status.

**True goal:** When an agent stops on something only you can do, you see it in
the same place as every other "needs you", with what to do, and you can answer
it from there. Things you do not need to see (a completed task's summary) stop
asking for your attention.

**Consumers:** You, in bb (Attention page, thread context card), in the
dashboard (every terminal session), and in the terminal (the widget, `/todo`,
`/attention`). The agent, which sets a task waiting and is woken by the answer.

**Success criteria:**

- A task the agent sets `waiting` shows as one attention item, with the agent's
  message as the reason, until the task leaves `waiting`.
- Where the session is live, bb and the dashboard offer **Reply** on the item.
  A reply records your text on the task, moves it back to `pending` and wakes
  the agent with it, exactly once, even across a reload.
- Where nothing can take a reply (a stopped bb thread), the item offers only
  the way to its thread. You tell the agent there, and it moves the task on.
- Completed tasks with messages no longer stand out: no unread marks, no
  `unreviewed` counts, no `/todo:review`.
- The new status is additive: a task with an unfinished prerequisite is still
  shown as `blocked`, as today.

**Non-goals:** A generic `attention_raise` tool. An agent-raised "please review
this" flag on a task. A reply box in the terminal (you reply in chat). Waking a
stopped bb thread with a reply. Any change to Pi or bb core.

**Constraints:** Bundle code and the bb plugin only. `AGENTS.md` runtime rules:
closure state, journal and replay, `pi-work` for anything a session waits on,
`pi-surface` for what other UIs show. Packages never import extensions.

## Answers

| Question                                                      | Answer                                                                                                                    | Source                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| What does pi-todo flag for review today?                      | Any model-written `message` newer than your last review of that task. Status-only and user updates are never flagged.     | `extensions/pi-todo/src/activity.ts:228` |
| Keep review tracking in any form?                             | No. Remove it completely.                                                                                                 | User, 2026-11-27                         |
| Let the agent mark a completed task "recommended for review"? | No: almost never needed.                                                                                                  | User, 2026-11-27                         |
| Offer Unblock in bb and the dashboard?                        | Only where you can give a reply that unblocks the task. Otherwise link to the thread and let the agent unblock it.        | User, 2026-11-27                         |
| Should a reply wake the agent?                                | Yes.                                                                                                                      | User, 2026-11-27                         |
| Update the orchestrate agent and the skills?                  | Yes.                                                                                                                      | User, 2026-11-27                         |
| Which option?                                                 | B: reply on the item.                                                                                                     | User, 2026-11-27                         |
| Name of the new status?                                       | `waiting` (waits on you). `blocked` keeps its meaning, a task with an unfinished prerequisite, so the change is additive. | User, 2026-11-27                         |

## Inputs

| Input                         | Owner / source today                                                                          | Proposed supply                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "This task waits on the user" | Prose in a task `message` on a `pending` task (`skills/execute-roadmap/SKILL.md:135`, `:229`) | Status `waiting`, set by the main session's agent with a required `message`: what you must do, and where.                                                      |
| What to do                    | The same `message`                                                                            | Unchanged: the message that set `waiting` is the item's reason.                                                                                                |
| The items                     | None: todo publishes no `attention` view                                                      | `todo.attention`, derived from the branch's task state on every change. Nothing new is journaled for it.                                                       |
| Your reply                    | Only the thread composer (bb) or the terminal                                                 | A new optional `reply` action on an attention item, dispatched with `{ text }`. Shown only while the session is live; settling drops it as it drops `dismiss`. |
| The wake                      | A user message, typed in the thread                                                           | One `pi-work` item per waiting task, completed by the reply. The work host writes it into the transcript and starts a turn, once, as for jobs and watches.     |
| Who may set it                | Anyone with the tool, including delegated subagents                                           | The main session only. A subagent asks its parent, as `git_pr_request_review` and `ask` already work.                                                          |

**Contract sketch: `AttentionItem.reply`.**

```ts
type AttentionItem = {
  // … as today
  /** Answers the item: dispatched with its arguments plus `{ text }`, the user's reply (1–2,000 characters). */
  reply?: ActionRef;
};
```

A consumer that shows `reply` collects one line or paragraph of text and
dispatches the action. One that does not know it ignores it, as an older bb
plugin would. `settleSnapshot` removes it with `open` and `dismiss`, so a saved
item never offers a reply nothing can receive.

**Why a work item and not `sendUserMessage`:** pi-work already handles the hard
cases of waking a session (a run in progress, compaction, abort, reload) and
delivers exactly once (`packages/pi-work/README.md`, "Delivery"). It also lists
the waiting task among what the session waits on in the dashboard. Opening an
item per waiting task is the `AGENTS.md` rule: anything a session waits on is a
`pi-work` item.

## What exists

**Prior art:**

- The attention contract and three consumers: `packages/pi-surface/src/attention.ts`,
  `attention-rows.ts`, `settle.ts`; bb's `ui/attention.tsx`; the dashboard hub;
  pi-attention's `/attention`.
- `git.attention` (`extensions/pi-git/src/attention.ts`) as a producer to copy:
  item ids, `rev`, an action that refuses a revision it did not show.
- The dashboard already collects free text and dispatches it as an action: its
  answer dialog for questionnaires (`extensions/pi-dashboard/src/hub/page.ts:786`).
- pi-work's root host and `adopt` (`packages/pi-work/README.md`).
- pi-surface's icon set already has `waiting` (`packages/pi-surface/src/model.ts:223`).
- bb's SDK can post a user message into a thread (`threads.send`,
  `bb-plugin/node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts:19323`).
  Not used by the chosen option; see Option C.

**Conventions to follow:** attention items are derived from saved state, so
`/tree`, resume and reload need no entries of their own; actions refuse a
revision they did not show; main-session-only tools refuse in a subagent with
"report to your parent"; command output through `userOutput`.

**Friction:**

| Friction                                                                                          | Evidence                                                                                   | Blocks                                 | Verdict                 |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------- | ----------------------- |
| Every model message is flagged until you open it, and flagged tasks sort above every status group | `activity.ts:228`; `ui/render.ts:57-74`; the `message` description, `index.ts:108`, `:697` | Seeing what needs you; the goal itself | Fix first               |
| Skills write a message at every stage, so nearly every task is flagged                            | `skills/execute-roadmap/SKILL.md:68-72`                                                    | The same                               | Fix first               |
| Attention items have no way to carry an answer                                                    | `packages/pi-surface/src/attention.ts:66-68` (`open`, `dismiss` only)                      | Reply from bb and the dashboard        | Fix first               |
| The session's own "Waiting for you" row already uses attention category `waiting`                 | `packages/pi-surface/src/attention-rows.ts:91`                                             | Reusing that category for tasks        | Work around: use `task` |
| The explorer `marker` contract (unread marks) loses its only producer                             | `extensions/pi-todo/src/ui/browser.ts:114`                                                 | Nothing                                | Leave                   |
| The skill says "There is no blocked or waiting status"                                            | `skills/execute-roadmap/SKILL.md:71`                                                       | The skill update                       | Fix with the change     |

**Noticed, not doing:** dropping the explorer `marker` contract from pi-surface,
pi-ui, bb and the dashboard (generic, harmless, and a later producer may want
it); waking a stopped bb thread with a reply through `threads.send`.

**Not examined:** how bb lays out a text box in an Attention row and the context
card (check with `bb-screenshot` in step 3); whether an open root work item
changes anything at the end of a run beyond the dashboard's "waiting on" list
(check in step 5).

## Options

**A. Thread is the reply (baseline).** Add `waiting`, publish the items with no
actions. bb opens the thread; the dashboard shows the row; you tell the agent,
and it moves the task on. No contract change, no work item. You cannot answer
from the Attention page or the dashboard, and an unblock depends on the agent
remembering to move the task.

**B. Reply on the item.** A, plus `AttentionItem.reply`. The reply is a pi-todo
action: it records your text on the task, sets `pending` and completes the
task's work item, which wakes the agent. bb and the dashboard show Reply only
while the session is live; otherwise the row offers the thread. Cost: two more
steps (contract and dashboard; bb). The task state and the wake are one action,
so they never disagree.

**C. bb posts the reply as a chat message.** A, plus a bb-only Reply that sends
"About task `<key>`: …" into the thread with `threads.send`. It works on a
stopped thread too, since bb starts Pi for a new message. Cost: bb only, no
contract change. But the dashboard gets nothing (it cannot send messages), and
the task stays `waiting` until the agent reads the message and acts.

|                                | A                   | B                | C                   |
| ------------------------------ | ------------------- | ---------------- | ------------------- |
| Reply from bb                  | via the thread      | yes, while live  | yes, even stopped   |
| Reply from the dashboard       | no                  | yes              | no                  |
| Task leaves `waiting` on reply | when the agent acts | at once          | when the agent acts |
| Contract change                | none                | `reply` on items | none                |
| Steps                          | 4                   | 6                | 5                   |

B is the only option that meets "Unblock only where you can reply, and the
reply wakes the agent" in both bb and the dashboard. C's stopped-thread reply
can be added later on top of B without changing it.

## Decision

Option B, chosen by the user on 2026-11-27. The new status is `waiting`, not
`blocked`: `blocked` keeps meaning a task with an unfinished prerequisite, so
nothing is renamed and the status is purely additive.

## Roadmap

### Make it easy

### 1. Remove review tracking

**Type:** cleanup
**Eases:** the goal itself (completed tasks stop asking for you), and step 4,
which edits the same widget, summary and browser code with the review paths
gone.
**Does:** in pi-todo, delete the review watermarks and everything that reads
them: `TodoReview*`, `applyTodoReview`, `isReviewable`, `unreviewedTodo*`,
`todoReviewMarks` (`activity.ts`); replaying `todo:review` entries
(`replay.ts`; old entries are ignored); `/todo:review` (`commands.ts`); the
`todo.review` action and the `reviewed` argument of `todo.inspect`
(`surface.ts`, `events.ts`); the browser's Unreviewed tab, marks and Ctrl+R
(`ui/browser.ts`); the widget's marks, `● N new` and the sort that puts flagged
tasks first (`ui/render.ts`); the `unreviewed` and `unreviewed-messages` counts
(`summary.ts`). Messages stay in each task's history and the widget's
last-message line stays. Reword the `message` parameter and guideline
(`index.ts:108`, `:697`) to "shown in the task's history"; drop "flagged until
the user reviews them". Outside pi-todo: the root README row, `verify-bundle.mjs`
and `command-names.mjs`, `test/scenarios/rpc-commands.test.ts`, the bb fixture
and tests, `docs/bb/ui-slots.md`, the tui-screenshot docs scenarios, and the
images they make (`todo-widget.png`, `todo-browser.png`). Mark
`extensions/pi-todo/docs/plans/0001-task-messages-and-review.md` superseded, and
mark the attention roadmap's step 10 dropped in favour of this plan.
**Done when:** `grep -ri "unreviewed\|todo:review\|todo\.review"` finds nothing
outside changelogs and the superseded plan; a session with old `todo:review`
entries loads.
**Verification:** `npm run test:workspace -- pi-todo`; the bb plugin's
`npm run typecheck` and `npm test`; `npm run verify:bundle`; the scenarios;
regenerate the README images.
**Ships alone:** yes.
**Rollback:** revert; old review entries are still in the session files.
**Depends on:** none · **Size:** M

### 2. Let an attention item take a reply

**Type:** contract
**Eases:** 5, which publishes items you answer.
**Does:** add `reply?: ActionRef` to `AttentionItem`, with its check in
`isAttentionItem` (`packages/pi-surface/src/attention.ts`); carry it through
`attentionRows` (`attention-rows.ts`); drop it in `settleSnapshot` with `open`
and `dismiss` (`settle.ts:127`). The dashboard shows **Reply** on a row that has
it, reusing the answer dialog's text box, and dispatches the action with
`{ text }`; on refusal it shows the error and keeps the draft. A row without
`reply` keeps today's buttons.
**Seam or contract:** `AttentionItem.reply`, dispatched with its arguments plus
`{ text }` (1–2,000 characters).
**Done when:** a fixture item with `reply` round-trips through validation and
`attentionRows`, loses it on settling, and the dashboard dispatches the typed
text.
**Verification:** `npm run test:workspace -- pi-surface`, `-- pi-dashboard`.
**Ships alone:** yes: nothing produces `reply` yet.
**Rollback:** revert; producers do not exist yet.
**Depends on:** none · **Size:** S

### 3. Reply from bb, or open the thread

**Type:** contract (consumer)
**Eases:** 5.
**Does:** in `bb-plugin/ui/attention.tsx`, a row with `reply` shows **Reply**,
which opens a text box in the row; sending dispatches the action through the
plugin's RPC, as Dismiss does. A failed send keeps the text and shows why. A row
with neither a link nor `reply` shows **Open thread**. A saved row never has
`reply` (settled), so a stopped thread offers only the thread: no queued
replies.
**Done when:** a fixture with a live reply item sends the text; the same item
saved offers Open thread only.
**Verification:** bb plugin `npm run typecheck` and `npm test`;
`bb-shot.mjs --expand --check` passes and a screenshot shows the Reply box.
**Ships alone:** yes.
**Rollback:** revert.
**Depends on:** 2 · **Size:** S

### The change

### 4. Add the `waiting` status

**Type:** the change
**Does:** `TodoStatus` gains `waiting` (`state.ts:21`, the tool schema at
`index.ts:93`, `/todo:update`'s check at `commands.ts:206`, activity's
`STATUSES`). Setting `waiting` requires a `message` in the same write: what the
user must do and where; without one the write is refused. A waiting task is
open: it counts toward the 50 open tasks, does not take an `in_progress` slot,
and holds back its dependents, which show as `blocked` as they do for any
unfinished prerequisite. Only the main session may set it: a write from a
delegated subagent, or in any session with a parent, is refused with "ask your
parent". The widget and `/todo` show it with the `waiting` icon and warning
tone, its message on the row; it sorts first; the summary adds a `waiting`
count. Tool guidance: "Set waiting, with a message saying what the user must
do, when only the user can move the task on; you can keep working on other
tasks. When the user answers in chat, move it back to pending or in_progress
yourself." README.
**Done when:** the agent can set a task waiting and move it on; the refusals
above happen; it shows in the widget, `/todo`, and bb's todo card; nothing
about `blocked` changes.
**Verification:** `npm run test:workspace -- pi-todo`; a TUI screenshot of the
widget with a waiting task.
**Ships alone:** yes: without step 5 it is a visible status, with no attention.
**Rollback:** revert; a session that saved `waiting` replays it as `pending`.
**Depends on:** 1 (same files) · **Size:** M

### 5. Waiting tasks as attention items that you can answer

**Type:** the change
**Does:** pi-todo publishes `todo.attention` from the current branch: one item
per waiting task, id `task:<key>`, `rev` the revision of the update that set
`waiting`, category `task`, title the subject, reason its message, `since` when
it started waiting, no link. Each carries `reply: { action: "todo.unblock",
args: { key, rev } }`.

For each waiting task it opens one `pi-work` item (owner `pi-todo`, kind
`waiting`, label the subject) and keeps the set in step with the branch on
every change, `session_start` and `session_tree`, adopting what a reload left
open.

`todo.unblock { key, rev, text }` refuses a task that is no longer waiting or
was set waiting again since (`rev`). Otherwise it records your text as a user
update on the task, sets it `pending`, and completes the work item with
"`<key>` was waiting on you: <message>. The user replied: <text>". The work
host writes that into the transcript and starts a turn. `/todo:update` that
moves a waiting task does the same with its `message`. The agent moving the
task itself cancels the item without a message.
**Done when:** wait → the item lists in `/attention`, bb and the dashboard →
reply → the agent wakes with the reply, the task is `pending`, the item is gone;
a stale reply is refused; a reload while waiting keeps one item and one work
item.
**Verification:** a scenario in `test/` (wait, list, reply through the action,
wake, reload in between, stale `rev`); `npm run test:workspace -- pi-todo`; in
bb, set a task waiting, reply from the Attention page, see the thread wake; stop
the thread and see Open thread only.
**Ships alone:** yes, after 2–4.
**Rollback:** remove the view, the action and the work items; tasks stay
`waiting` and the agent moves them on.
**Depends on:** 2, 3, 4 · **Size:** M

### 6. The orchestrate agent and the skills use `waiting`

**Type:** the change
**Does:** the orchestrate prompt (`extensions/pi-subagent/agents/orchestrate.md:49`):
"set the task `waiting` with a message saying what you need from the user and
where"; and, when it runs as the main agent, hand a pull request ready for
review to the user with `git_pr_request_review` at the head it checked.
`execute-roadmap`: a step it cannot continue without the user (`:135`, a
closed pull request at `:229`, a failed deploy check) is set `waiting` with
that in its message, not `pending`; drop "There is no blocked or waiting status"
(`:71`), keeping a pull request waiting on review `in_progress` with its
`git_pr_request_review` item, so it is not listed twice. `skills/README.md`.
Tests that assert on the prompt text follow.
**Done when:** no skill or agent prompt records "waits on the user" on a
`pending` task.
**Verification:** `npm run test:workspace -- pi-subagent`; `npm run verify:bundle`.
**Ships alone:** yes, after 4 (5 makes it visible).
**Rollback:** revert the text.
**Depends on:** 4 · **Size:** S

Start with step 1. It is safe to start today, and step 2 can run beside it.

## Open questions

- How bb best fits a text box into an Attention row and the context card;
  settle with a screenshot in step 3.
- Whether an open root work item affects anything at the end of a run beyond
  the dashboard's "waiting on" list; check in step 5 before relying on it.
