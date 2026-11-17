# pi-ask

One `ask` tool for questions, routed by session: a subagent asks the agent that
delegated to it, and the main session asks you. A second tool, `user_notify`,
alerts you without waiting for an answer; see [Notifying you](#notifying-you).

## The tool

```json
{
  "questions": [
    {
      "question": "Which database should the service use?",
      "header": "Storage",
      "options": [
        { "label": "Postgres (Recommended)", "description": "Already in production" },
        { "label": "SQLite", "description": "No server to run" }
      ]
    },
    { "question": "Anything else I should know?" }
  ]
}
```

| Field                     | Limit           | Notes                                                  |
| ------------------------- | --------------- | ------------------------------------------------------ |
| `questions`               | 1-4             | Independent questions, answered in one window          |
| `questions[].header`      | 16 characters   | Optional tag shown beside the question                 |
| `questions[].options`     | 0-4             | Optional choices; without them the question takes text |
| `options[].label`         | 60 characters   | Labels must be distinct within a question              |
| `questions[].multiSelect` | default `false` | Allows several choices                                 |

Every question also takes a free-text answer, so the model never needs an
"Other" option. `ask` is `model-only`: codemode scripts and `job_watch` checks
cannot call it.

## Routes

The route is chosen when the session starts. In an RPC session, whether a form or Pi's
own dialogs ask is decided for each question (see
[Answering from outside the terminal](#answering-from-outside-the-terminal)).

| Session                          | Route  | What happens                                                                                                |
| -------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| A subagent                       | parent | The subagent waits on a question item and its turn ends; the parent is told once and answers with a message |
| Interactive terminal             | user   | An inline window opens under the transcript and waits for your answer; a live form consumer can answer too  |
| RPC host with a form consumer    | user   | The questionnaire is published as a form for the consumer to answer                                         |
| RPC host (editor integrations)   | user   | One host dialog per question                                                                                |
| No UI and no parent (print/json) | none   | The tool is hidden                                                                                          |

While the inline window is open, the todo and subagent widgets above it shrink
to their heading rule so the question keeps its rows. Scrolling the transcript
minimizes the window to three rows; any key or scrolling back to the end
restores it.

The tool's description and guidelines differ by route, because the two behave
differently: asking you blocks and returns your answer, while a subagent's
question does not block. The subagent's turn ends (the tool returns
`terminate: true`, so Pi stops after the tool batch; call `ask` on its own, since
a batch that mixes it with other tools continues), the subagent is idle and
waiting, and the parent's next message to it is the answer.

A subagent asks through the session's work host ([pi-work](../../packages/pi-work/README.md)):

1. `ask` opens an item of kind `question` (owner `pi-ask`, label `answer`, data
   `{ toolCallId, questions, text }`) in the subagent's own host. An open item keeps
   a session from being released, so the question holds the subagent's session like
   a running job does.
2. It tells the parent once, through the `work:parent` service the delegating
   extension offers under the child's session id before the child's extensions
   load (pi-subagent does for every child). Another delegating extension can offer
   the same service:

   ```ts
   provide(childSessionId, "work:parent", {
     question(text: string) {
       /* tell the delegator, once */
     },
   });
   ```

3. The delegator answers by closing the question item (`cancelOpen` on the child's
   host, for items of kind `question`) and giving the subagent its answer as the next
   prompt. pi-subagent does both in `subagent_send`.

pi-ask adopts its open question items at `session_start`, so a question survives a
reload or restart of the subagent's session: it stays open, the delegator is not
told again, and the host does not report it lost. A parent `/reload` or restart
reopens a waiting subagent without a model run (pi-subagent does it at its own
`session_start`), which is what gives pi-ask this chance to adopt. A question item found in a
session that asks the user is not adopted.

The root session's route is unchanged. A subagent's question is never published as a
form, even when something on its bus advertises a form consumer.

## Answering in the terminal

The window replaces the editor while it waits and keeps focus.

- `↑`/`↓` move, `enter` chooses, a number picks directly.
- Multi-select: `space` toggles, `enter` confirms.
- The last row, **Type something…**, takes your own words.
- `←`/`→` (or `tab`) switch questions; answering moves to the next unanswered one,
  and the last answer submits.
- `esc` dismisses the questions; the model is told you declined.

In fullscreen mode, scrolling the transcript (mouse wheel or `PageUp`) shrinks
the window to three rows (its title, the waiting question and a hint) so you can
review the session. The next key scrolls
back to the end and restores the window; that key is not used as an answer. In
regular mode your terminal owns scrollback, so the window stays inline at the
bottom.

## Answering from outside the terminal

pi-ask owns every questionnaire waiting for the user. One pending record per asking tool
call is shared by whatever shows it, and one completion path settles it: the first valid
answer or cancellation wins, every other display withdraws it, and a later answer is
refused.

While a questionnaire is published, it is listed in the `ask.questions` form view
([pi-surface](../../packages/pi-surface/README.md#session-summary-and-form-models)), oldest
first, under the asking tool call's id. Each entry carries two action references:

| Action       | Arguments                                                                                                  | Result                        |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `ask.submit` | `{ id }` plus a `FormAnswer`: `answers: [{ questionIndex, optionIndexes?, text?, notes? }]`, `globalNote?` | `{ id, status: "answered" }`  |
| `ask.cancel` | `{ id }`                                                                                                   | `{ id, status: "cancelled" }` |

Both refuse anything else in the arguments. The answer is checked against pi-surface's
`isFormAnswer` and then against the questionnaire, all or nothing, as `ask:answer` is
(see [Events](#events)). A refused answer rejects the dispatch with
`Not accepted (<code>): <reason>`. An `invalid_answer` leaves the questionnaire waiting;
`closed` means it was already answered or cancelled (a duplicate or stale answer), and
`not_found` that no questionnaire with that id is open for answers from outside.

Where it is published depends on the session:

- **Terminal.** The inline window opens and the same record is published, so a live
  consumer (such as the dashboard) can answer it as well. When the consumer answers first,
  the window closes; when you answer in the terminal, the form withdraws it.
- **RPC with a form consumer.** A consumer advertises with pi-surface's
  `advertiseFormConsumer` once it can render and answer forms. pi-ask then publishes the
  questionnaire instead of opening dialogs. When the last consumer withdraws before an
  answer, the questionnaire leaves the form for good and Pi's own dialogs ask it instead;
  from then on only the dialog answers it, even if a consumer returns. Where Pi has no
  dialog to show (its context is gone), the questions are withdrawn and the model is told
  so.
- **RPC without one.** Pi's own dialogs, exactly as before: nothing is published and nothing
  outside the dialog can answer. This is the route under bb until its plugin advertises.

A form holds at most `MAX_FORM_QUESTIONNAIRES` (8) questionnaires within pi-surface's text
bounds and its 256 KiB view limit. A question that would not fit is refused before anything
is shown, with a message telling the model why, so no tool call waits behind a form nobody
can draw. Pi's own dialogs are not part of the form and are not limited by it.

Questions withdrawn before anyone answered say why, in the tool result (`details.reason`)
and in the transcript row:

| `reason`      | When                                                                     |
| ------------- | ------------------------------------------------------------------------ |
| `aborted`     | The asking call was aborted                                              |
| `unavailable` | The last form consumer went and Pi had no dialog to ask the questions in |
| `ended`       | The session was reloaded or shut down while they waited                  |

A cancellation without a reason is the user declining, in the terminal or through
`ask.cancel`.

## Notifying you

`user_notify { title, body }` sends a native notification through cmux and
returns at once. It is for the moment an agent ends its turn waiting on
something only you can do outside the session: review or merge a pull request,
unblock a step, look at a failed check. Unlike a questionnaire's notification
it carries the model's own text, and nothing dismisses it: it stays until you
clear it.

| Field   | Limit          | Notes                                         |
| ------- | -------------- | --------------------------------------------- |
| `title` | 80 characters  | What needs you, in a few words                |
| `body`  | 300 characters | What to do and where (a URL, a step, a check) |

Both are reduced to one line of plain text before they are sent. The result
says whether a notification was shown (`details.delivered`). Outside cmux, with
`CMUX_PI_HOOKS_DISABLED=1`, or when the CLI fails, the call still succeeds: the
message is in the transcript only and the model is told not to retry.

Only the main session has the tool. In a subagent, and where there is no
terminal, it is hidden and a stray call is refused; a subagent reports to its
parent with `parent_notify` instead.

## Optional cmux notifications

Inside cmux, opening a root terminal questionnaire also sends a native notification
with a generic message (never the questions or answers). The inline UI is unchanged.
Answering, cancelling or encountering an error dismisses only that questionnaire's
notification, including when its creation receipt arrives after closing. RPC dialogs
and questions routed to a parent agent do not notify.

This uses the public `cmux` CLI automatically when `CMUX_SURFACE_ID` (or legacy
`CMUX_PANEL_ID`) is set, with an optional `CMUX_WORKSPACE_ID`/`CMUX_TAB_ID` target.
It prefers `CMUX_BUNDLED_CLI_PATH`, then `cmux` on PATH, and preserves the inherited
socket environment. Set `CMUX_PI_HOOKS_DISABLED=1` to opt out; no settings are needed.
The CLI wrapper is `CmuxNotifications` in `packages/pi-foundations/src/cmux.ts`, shared
with `user_notify`.
Without cmux, or if the CLI fails or times out, questions work exactly as before.
Creation and dismissal never wait on the question's interaction path; shutdown
briefly drains pending work. If cmux creates a notification but its receipt is lost,
pi-ask cannot safely identify it to dismiss it and will not clear other notifications.

cmux may suppress native banners while its target pane is focused; its own
notification settings control this behavior.

## Events

pi-ask publishes on the session's `pi.events` bus, keyed by the asking tool
call's id (`src/events.ts`):

| Channel             | Direction | Payload                                                                                                             |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| `ask:opened`        | out       | `{ toolCallId, questions: [{ question, header, multiSelect, options: [{ label, description }] }] }`                 |
| `ask:closed`        | out       | `{ toolCallId, outcome: "answered" \| "cancelled" \| "error" }`                                                     |
| `ask:answer`        | in        | `{ toolCallId, requestId?, answers?: [{ questionIndex, optionIndexes?, text?, notes? }], globalNote?, cancel? }`    |
| `ask:answer-result` | out       | `{ ok, code?: "not_found" \| "closed" \| "invalid_payload" \| "invalid_answer", reason?, requestId?, toolCallId? }` |

`ask:opened` and `ask:closed` go out for every published questionnaire (the terminal's and
the RPC form route's), never for Pi's own dialogs. `ask:answer` answers a published
questionnaire, checked all or nothing: every question answered once, a single-select with
exactly one choice or text. The first answer wins. These events remain while
pi-presentation reads them for bb; pi-dashboard uses the form view and its actions.

From session start to shutdown pi-ask also defines the `ask.answer` action on
the same bus (see [`pi-surface`](../../packages/pi-surface/README.md)). It takes
the `ask:answer` payload and resolves to the `ask:answer-result` reply, refusals
included, to its caller only. pi-presentation's `answer` request goes through it;
pi-dashboard answers through the form's `ask.submit` and `ask.cancel`.

## Configuration

None.
