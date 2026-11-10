# pi-ask

One `ask` tool for questions, routed by session: a subagent asks the agent that
delegated to it, and the main session asks you.

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

The route is chosen when the session starts.

| Session                          | Route  | What happens                                                                                                |
| -------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| A subagent                       | parent | The subagent waits on a question item and its turn ends; the parent is told once and answers with a message |
| Interactive terminal             | user   | An inline window opens under the transcript and waits for your answer                                       |
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
told again, and the host does not report it lost. A question item found in a
session that asks the user is not adopted.

The root session's route is unchanged.

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
Without cmux, or if the CLI fails or times out, questions work exactly as before.
Creation and dismissal never wait on the question's interaction path; shutdown
briefly drains pending work. If cmux creates a notification but its receipt is lost,
pi-ask cannot safely identify it to dismiss it and will not clear other notifications.

cmux may suppress native banners while its target pane is focused; its own
notification settings control this behavior.

## Events

pi-ask publishes on the session's `pi.events` bus, keyed by the asking tool
call's id (`src/events.ts`):

| Channel             | Direction | Payload                                                                                                          |
| ------------------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `ask:opened`        | out       | `{ toolCallId, questions: [{ question, header, multiSelect, options: [{ label, description }] }] }`              |
| `ask:closed`        | out       | `{ toolCallId, outcome: "answered" \| "cancelled" \| "error" }`                                                  |
| `ask:answer`        | in        | `{ toolCallId, requestId?, answers?: [{ questionIndex, optionIndexes?, text?, notes? }], globalNote?, cancel? }` |
| `ask:answer-result` | out       | `{ ok, code?: "not_found" \| "invalid_payload" \| "invalid_answer", reason?, requestId?, toolCallId? }`          |

`ask:answer` is checked all or nothing: every question answered once, a
single-select with exactly one choice or text. pi-dashboard answers from the
browser this way; the first answer wins.

## Configuration

None.
