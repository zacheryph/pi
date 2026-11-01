---
issue: 987
issue_title: "pi-subagents: `resume` ignores `run_in_background`, so resuming a background agent blocks the parent until the resumed run finishes"
---

# Retro: #987 — pi-subagents: `resume` ignores `run_in_background`, so resuming a background agent blocks the parent until the resumed run finishes

## Stage: Planning (2026-10-02T19:14:27Z)

### Session summary

Planned a fix for a third-party report that the `subagent` tool's `resume` path ignores `run_in_background`.
The reporter's code trace held; planning also found that a carrier claim is never released after delivery, so a naive background resume would never be announced.
The plan has six steps: extract a shared launch renderer (folding in #988), split `SubagentManager.resume` into a synchronous `startResume`, release stale claims per resume, widen the tool's manager seam, add the background branch, and update the docs.

### Observations

- The stale-claim hazard was confirmed with a throwaway Vitest spike against the real `SubagentManager` (since removed).
  After `spawnAndWait` followed by an unclaimed `resume`, and after a claimed resume followed by an unclaimed one, `record.claimed` stayed `true` in both cases.
  The service's unclaimed `resume` has the same latent defect, and the README contract already promises an announcement.
- Operator decisions at the gate:
  - A resume runs in the background only on an explicit `run_in_background: true`.
    Frontmatter defaults and `locked:` are not consulted.
  - It starts immediately, with no `maxConcurrent` admission; that is filed as #1013.
  - #988 is folded in as a tidy-first renderer extraction.
- Follow-ups filed: #1012 (no widget row when a foreground-spawned agent is resumed in the background) and #1013 (limiter admission).
  `roadmap-fit` exited at step 1 because the package has no open improvement phase.
- The Tidy-First assessor recommended the renderer extraction, the `startResume` split, and the fixture/seam step.
  It rejected merging `resumeExisting` with the background branch.
  It found no existing test that asserts a claim survives an unclaimed resume.
- #988's body cites a reporter-side commit (`a2712e2`) that exists in neither this repo nor the reporter's public forks, so it could not be read.
  The design does not depend on it.
- The `Co-authored-by: Sungbin Jo <goranmoomin@daum.net>` trailer is recorded on step 5, using the address from an earlier credited commit.

## Stage: Implementation — TDD (2026-10-02T19:39:42Z)

### Session summary

I implemented all six plan steps, plus one extra characterization commit, with every step's named killing mutation applied and observed red.
The `subagent` tool now resumes in the background on an explicit `run_in_background: true`, and a resume nobody claims clears a stale carrier claim, so it is announced.
The pi-subagents suite went from 1898 to 1915 tests (+17).

### Observations

- Deviation: I added an extra `test:` commit ("pin the background spawn launch message verbatim") before the renderer extraction.
  The existing `spawnBackground` tests used `toContain`, so they could not hold the text byte-identical as the plan claimed.
- Deviation: `mockResumeStart`/`mockResumeStartRefusal` moved from step 4 into step 5's commit.
  With no consumer yet, `fallow dead-code` flagged them in step 4.
- The background-resume tool test expects `Type: Agent`, which is the display name the test registry resolves for `general-purpose`, not the type name the plan's sketch implied.
- The "leaves the resumed outcome uncollected" and "ignores an agent file's default" tests were green during Red, as deliberate pins.
  Mutations (d) and (b) each killed exactly the pin they target.
- Mutation (a) killed four tests, not just the one the plan named, because every background-resume assertion depends on the branch existing.
- Mid-step, a Python block move misplaced a test across `describe` blocks.
  I recovered with `git checkout` of the test file and a single anchored `Edit`; per the `edit-tool` skill, prefer `Edit` for block insertion over scripted moves.
- Pre-completion reviewer: PASS.
  It re-derived all three claim producers (`spawnAndWait`, a claimed resume, the `get_subagent_result` wait) and confirmed each is stale by the time a resume can start.
  It noted one pre-existing race, which this change does not make worse.
  A `get_subagent_result(wait: true)` waiter that wakes after a resume has begun calls `release()` unconditionally and could clear a foreground resume's claim.
  That needs two concurrent parent tool calls on one agent; I have not filed it.

## Stage: Sync (worktree) (2026-10-02T19:47:14Z)

### Session summary

`pnpm run lint` and `pnpm fallow dead-code` both pass on the worktree.
The plan's marker is `**Release:** ship independently`; the follow-ups #1012 and #1013 are filed and #988 is folded in, so `/ship` should close #987 and #988.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-987--/2026-10-02T19-06-50-447Z_01a0fe03-16ce-75b8-8d8f-38b9b63ed1e4.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

The pre-completion reviewer's unfiled observation (a `get_subagent_result` waiter waking after a resume began can clear a foreground resume's claim) is worth a look at the final retro.

## Stage: Final Retrospective (2026-10-02T20:16:09Z)

### Session summary

The worktree peer planned and implemented the fix in seven commits, and the root fast-forward-merged it, passed CI, and released `pi-subagents-v21.9.3`.
The ship closed #987 and its folded-in sibling #988, and credited the reporter.
The one loose end is the pre-completion reviewer's unfiled race, which went through Sync and Ship without anyone deciding on it.

### Observations

#### What went well

- Planning ran a throwaway spike against the real `SubagentManager` before the design gate, and it found the stale-claim defect: no producer ever released `record.claimed`.
  Without it, the naive fix (skip the `await`) would have told the parent "you will be notified" and then never notified it in the ask-back loop, which is the case the issue is about.
  The defect became its own `fix:` commit (dab3c0532316f5a9bee3e84683ef49e49abe4526), and it also repairs the service's unclaimed `resume`.
- TDD step 5 ran all five named killing mutations in one bash call.
  A small `run(){ …; cp /tmp/green-at.ts $F; }` function applied each `perl` mutation, ran the suite, and restored the green file, so five mutations cost one tool call instead of ten.
- TDD added a characterization `test:` commit (b89eacd9450d1b6639ba8eaa1b301b1b41e0c027) before the renderer extraction, because the existing `toContain` assertions could not hold the text byte-identical.
  It's a good example of tidy-first working as intended: the plan assumed a pin that did not exist, and implementation caught it before the refactor depended on it.

#### What caused friction (agent side)

- `instruction-violation` (self-identified) — in TDD step 3, a `python3` block move put the new `describe` in the wrong parent block.
  The `edit-tool` skill already prefers an anchored `Edit` for block insertion.
  Impact: two extra tool calls (`git checkout` of the test file, then a single `Edit`); no commit rework.
- `instruction-violation` (self-identified, at retro) — the #987 close comment cites the short hash `dab3c05` in prose, while the pre-publish check resolved only the full SHAs in the bullets.
  `/ship` asks to re-resolve every hex token in the finished draft.
  It is a correct prefix of a verified SHA, so nothing was published wrong.
  Impact: none; it shows the check ran over the SHAs I meant to cite, not the draft text.
- `other` — the reviewer's race observation (a `get_subagent_result(wait: true)` waiter that wakes after a resume began calls `release()` and can clear a foreground resume's claim) was recorded as "not filed" in TDD and flagged again in Sync.
  Ship then passed it along only as a final-report line.
  Nothing in any stage required a file-or-drop decision.
  Impact: no rework; it survived only because the Sync note named it for this retro.

#### What caused friction (user side)

- None observed; the planning gate's three decisions (explicit-flag-only, no limiter admission, fold #988) were answered once, without follow-up.

### Diagnostic details

- **Model-performance correlation** — the peer ran Planning and TDD on `claude-opus-5-5` and Sync on `claude-sonnet-5-5`; the root ran Ship on `claude-sonnet-5-5`.
  Both subagents (the `tidy-first-assessor` and the `pre-completion-reviewer`) ran on `claude-sonnet-5-5`, according to their own transcripts.
  The judgment-heavy stages ran on the stronger model and the mechanical stages on the cheaper one, so nothing was mismatched.
- **Feedback-loop gap analysis** — TDD ran the targeted Vitest file and `check` after every Green, and `fallow dead-code` per step.
  That per-step `fallow` run is what caught the unused mock helpers in step 4, and they were moved to step 5 instead of being committed as dead code.

### Changes made

1. Filed #1015 for the `get_subagent_result` / resume claim race.
   Before filing, a read of `src/tools/get-result-tool.ts` corrected the reviewer's wording: the waiter's `release()` is not unconditional.
   It runs on the abandoned-wait branch (`isActive()` after the wait), which a resume that starts in the window makes true.
   `roadmap-fit` exited at step 1, since `pi-subagents` has no open improvement phase.
2. No prompt, skill, or `AGENTS.md` changes; both self-identified violations are already covered by the `edit-tool` skill and `/ship` step 9.
