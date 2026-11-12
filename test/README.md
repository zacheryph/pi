# Bundle scenario tests

Tests for behaviour that exists only when the bundle's extensions run together.
Each scenario loads the whole bundle in-process on
[pi-scripted-model](../packages/pi-scripted-model/README.md): real tools, real
extensions and real subagents, no API key or network.

| Scenario                            | What crosses extensions                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `scenarios/todo-delegation.test.ts` | pi-todo's broker and claims: a task handed to a subagent, updated there, accepted here. |
| `scenarios/stash-adoption.test.ts`  | pi-stash `adopt`/`passUp`: a subagent's entry listed and read in the parent.            |
| `scenarios/git-worktree.test.ts`    | pi-git's ledger names the subagent that ran in a worktree.                              |
| `scenarios/job-wake.test.ts`        | pi-job through pi-work's root host: a finished job starts the next turn, once.          |
| `scenarios/child-question.test.ts`  | pi-ask through pi-work's parent link: one question, answered with `subagent_send`.      |
| `scenarios/context-cards.test.ts`   | One `todo`, `stash`, `git` and `subagent` card each after compaction and after resume.  |

Assert on what the model was sent (`requests()`) and on tool runs
(`toolRuns()`, or `childRuns` for a subagent's transcript), not on extension
internals, so the scenarios survive refactors. `support/session.ts` opens one
session per test and disposes it when the test ends. The harness allows one open
session per process, so tests in a file run one after another; vitest runs
the files in parallel workers.

```bash
npm run test:workspace -- test
```

CI runs this workspace whenever any extension or package changes. Nothing here
is in the bundle manifest, and `verify:bundle` fails if it ever is.
