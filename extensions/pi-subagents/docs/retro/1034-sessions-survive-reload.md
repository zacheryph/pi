---
issue: 1034
issue_title: "pi-subagents: /subagents:sessions is empty after /reload"
---

# Retro: #1034 — pi-subagents: /subagents:sessions is empty after /reload

## Stage: Planning (2026-10-06T06:01:00Z)

### Session summary

Confirmed the cause in Pi's `AgentSession.reload()`: it emits `session_shutdown` to the old runner, then re-runs the factory, which builds a fresh empty `SubagentManager`.
The operator chose to rebuild the picker from the parent session's existing `subagents:record` entries, read from the whole session file via `getEntries()`.
The plan has five steps: a test helper, an entry-contract module, new `outputFile`/`toolUses` entry fields, a tolerant reader, and the picker wiring as the `fix:` step.

### Observations

- `subagents:record` had a writer and no reader anywhere in the repo, so the entry contract is free to grow; it lacked `outputFile` and `toolUses`, which the snapshot entry needs.
- Rejected: a `globalThis` manager handoff (new mechanism, reload-only) and a `tasks/` directory scan (child files carry no agent id, type, or description to label with).
- Fallow zones forbid `ui` → `observation`, so the contract lives at the package root (`src/persisted-record.ts`, zone `core`).
- Side effect, accepted: `/resume` and forked sessions now list their earlier subagents too.
- One-time gap: entries written before upgrade carry no `outputFile` and stay unlisted.
- Unverified: whether a run aborted by the reload's shutdown gets its terminal entry appended before Pi invalidates the old runner.
  Step 5's live check records the answer.
- The Tidy-First assessor recommended one preparatory step, a `handleWith` helper in `test/ui/session-navigator.test.ts`, which is in the plan as Step 1.
  It also confirmed that `composition-root.test.ts` does not drive the command.

## Stage: Implementation — TDD (2026-10-06T06:28:52Z)

### Session summary

All five TDD steps landed, plus a separate docs commit.
`subagents:record` entries now carry `outputFile` and `toolUses`, and `/subagents:sessions` lists the persisted runs the manager no longer holds as transcript snapshots.
The pi-subagents suite went from 2050 to 2065 tests.

### Observations

- Every killing mutation reddened exactly the tests the plan predicted.
  Dropping `outputFile` from `toPersistedRecord` reddens only the builder test: the observer fixtures carry no session, so `outputFile: undefined` matches an absent key under `toHaveBeenCalledExactlyOnceWith`.
- Process slip, twice: I issued the green-file `cp` backup in the same tool batch as the mutating `Edit`, so the backup captured the mutation.
  Both times I caught it and restored the code by hand before committing.
  The template's rule (separate turn for the `cp`) is correct as written; I just didn't follow it.
- Deviation: `toPersistedRecord` takes `PersistedSubagentRecord` itself instead of a separate `PersistedRecordSource` alias, because the alias would have been identical.
- Deviation: the README, `architecture.md` and package-skill updates landed as their own `docs(pi-subagents):` commit, per the template, instead of inside the `fix:` commit.
- Not done: the live `/reload` check (and whether a run aborted at reload gets its entry recorded) could not run in this non-interactive session.
  The `src/index.ts` relay `sessionEntries: ctx.sessionManager.getEntries()` is typechecked but has no test pinning it.
- Pre-completion reviewer: WARN.
  Its two findings are the `PersistedRecordSource` deviation (accepted) and the unpinned `index.ts` relay, which needs a manual `/reload` then `/subagents:sessions` check before or at ship.

## Stage: Sync (worktree) (2026-10-06T06:31:15Z)

### Session summary

Pre-push `pnpm run lint` and `pnpm fallow dead-code` passed.
The plan's marker is `**Release:** ship independently`.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-1034--/2026-10-06T05-47-54-527Z_01a10fc1-151e-7376-9329-8189fa3db79a.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

- The reviewer WARN on the unpinned `index.ts` relay was settled with the operator: they will run the live `/reload` then `/subagents:sessions` check themselves, so `/ship` should not block on it.
- That check should also note whether a run still active at `/reload` is listed afterwards; if it is missing, file a follow-up.

## Stage: Final Retrospective (2026-10-06T06:39:42Z)

### Session summary

The issue went through four stages: planning, TDD, and sync in one peer worktree session, then `/ship` at the root.
The ship fast-forward-merged the branch, CI passed on the first try, #1034 closed, and `pi-subagents-v23.2.0` was released.
The live `/reload` check is the only open item, and the operator chose to own it.

### Observations

#### What went well

- The planning gate laid out three cause-grounded options (session entries, `globalThis` handoff, directory scan) and a second question on `getEntries()` versus `getBranch()`.
  The operator answered once and nothing bounced.
- Every killing mutation in TDD reddened exactly the tests the plan predicted, including the one that showed a vacuous-looking assertion was covered elsewhere (`outputFile: undefined` against an absent key).
- The open reviewer WARN went from TDD (unpinned `src/index.ts` relay) to the operator decision at sync to `/ship`'s close comment without a second ask.
  The sync note recorded the decision explicitly, so `/ship` step 2 could honor it rather than re-ask.

#### What caused friction (agent side)

- `instruction-violation` (self-identified, twice): in TDD steps 2 and 4, the `cp <file> /tmp/green.ts` backup went in the same tool batch as the mutating `Edit` (peer turns 52 and 70).
  Batched calls run concurrently, so the backup captured the mutation.
  `.pi/prompts/tdd-plan.md` already says to run the `cp` in its own tool call, and the plan warned about the same trap, yet the second slip came two steps after the first was caught.
  The pattern that never failed was turn 60's: the `cp` appended to the Green verification command, which by construction finishes before any mutation is issued.
  Impact: two hand restorations (one `grep` diagnosis and one `Edit` each); no bad commit.

#### What caused friction (user side)

- None observed.
  The operator's one structural input (owning the live check) came at the sync gate, which is the earliest point the WARN existed.

### Diagnostic details

- **Model-performance correlation:** planning and TDD ran on `claude-opus-5-5`; sync ran on `claude-sonnet-5-5`.
  Both subagents (`tidy-first-assessor`, `pre-completion-reviewer`) ran on `claude-sonnet-5-5` per their transcripts.
  Each fit its task: the assessor's helper recommendation became plan Step 1, and the reviewer's WARN was the right call.
- **Feedback-loop gap analysis:** TDD ran targeted `vitest` plus `pnpm run check` after every Green, and the full gates at baseline and at the end.
  No gap.

### Changes made

1. `.pi/prompts/tdd-plan.md`: step 3 now appends the green-file `cp` to the Green verification command instead of asking for a separate tool call.
