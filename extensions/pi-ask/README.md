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

| Session                          | Route  | What happens                                                                                       |
| -------------------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| A subagent                       | parent | The question is recorded on the run; the subagent ends its turn and the parent answers by resuming |
| Interactive terminal             | user   | An inline window opens under the transcript and waits for your answer                              |
| RPC host (editor integrations)   | user   | One host dialog per question                                                                       |
| No UI and no parent (print/json) | none   | The tool is hidden                                                                                 |

The tool's description and guidelines differ by route, because the two behave
differently: asking you blocks and returns your answer, while asking a parent
cannot block (a parent waiting in the foreground for this subagent would
deadlock), so the subagent records the question and ends its turn.

A subagent reaches its parent through the `ask:route` service that pi-subagent
offers under the child's session id before the child's extensions load.
Another delegating extension can offer the same service:

```ts
provide(childSessionId, "ask:route", {
  record(question: string) {
    /* … */
  },
});
```

## Answering in the terminal

The window replaces the editor while it waits and keeps focus.

- `↑`/`↓` move, `enter` chooses, a number picks directly.
- Multi-select: `space` toggles, `enter` confirms.
- The last row, **Type something…**, takes your own words.
- `←`/`→` (or `tab`) switch questions; answering moves to the next unanswered one,
  and the last answer submits.
- `esc` dismisses the questions; the model is told you declined.

In fullscreen mode, scrolling the transcript (mouse wheel or `PageUp`) shrinks
the window to a one-line bar so you can review the session. The next key scrolls
back to the end and restores the window; that key is not used as an answer. In
regular mode your terminal owns scrollback, so the window stays inline at the
bottom.

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
