---
issue: 714
issue_title: "Surface preserved rescue worktrees at session start"
---

# Retro: #714 — Surface preserved rescue worktrees at session start

## Stage: Planning (2026-08-10T19:02:40Z)

### Session summary

Produced `docs/plans/0714-surface-preserved-rescue-worktrees.md`, planning the visibility loop [#704] left open in six steps: a live-worktree registry, path-heuristic discovery, provider wiring, a `session_start` toast, a `/subagents-worktrees` command that lists and (after confirmation) removes a preserved worktree, and the README update.
The issue explicitly left the surface undecided, so the operator answered a three-part `ask_user` gate: toast-only notice, slash command with confirmed removal, path heuristic for detection.
Every non-obvious mechanism in the design was measured in this session rather than assumed.

### Observations

- **The realpath mismatch would have shipped a feature that finds nothing.**
  `git worktree list --porcelain` prints resolved paths (`/private/var/…` on macOS) while `os.tmpdir()` returns `/var/…`, so the obvious `startsWith(tmpdir())` filter matches zero worktrees on the reporter's own platform.
  Measured with a scratch repo; the plan pins it with an assertion on returned paths rather than a count, because a count assertion would pass against the wrong strings.
- **"Once per process" is not achievable, so the notice is once per session.**
  Pi's loader calls the extension factory per session and `jiti` runs with `moduleCache: false`, so neither closure nor module state survives across sessions.
  The issue's title already says "at session start", so this is a non-issue — but the first design sketch had a `let reported` flag that would silently have been per-session anyway.
- **Child sessions were a real noise risk with a free mitigation.**
  `session_start` fires for every subagent session and its `reason` is `"startup"`, so the reason cannot identify a child.
  Pi substitutes `noOpUIContext` when no UI is bound, so a child's toast goes nowhere; guarding on `ctx.hasUI` both suppresses the dead toast and keeps a pointless `git worktree list` out of every child.
- **The path heuristic needs two false-positive guards, not one.**
  A live child's worktree looks exactly like a preserved one, hence the `ActiveWorktrees` registry.
  Less obvious: a session launched *inside* a rescue worktree during recovery would otherwise offer to delete the ground it stands on.
- **Rejected alternatives, with the reason.**
  `git worktree lock --reason` was measured to work well — the reason shows in `--porcelain` and the lock defeats even `remove --force` — but it only marks worktrees preserved after this ships, and a tmp-reaped locked entry survives `prune` as permanent repo cruft.
  A marker file carries richer metadata but adds a write on the failure path.
  The operator chose the heuristic, which has the compensating virtue of finding worktrees preserved by the already-shipped v0.2.4.
- **An agent tool was rejected in favor of a slash command.**
  Both let the user act without leaving the session; only one puts a destructive `git worktree remove --force` within the model's reach.
- **The existing "no-ops without the subagents service" test is load-bearing.**
  It asserts `pi.on` is never called, so the new notice and command must register *after* the service check — recorded as invariant 1 rather than discovered during implementation.
- Session-start cost measured at ~9 ms for one `git worktree list --porcelain`, so no caching or debouncing is planned.

## Stage: Implementation — TDD (2026-08-10T19:51:35Z)

### Session summary

Landed the plan's six steps plus two `test:` commits — the tidy-first `makeProvider` extraction and one fallow fixup — for eight commits in all.
A session with a UI now warns at startup about rescue worktrees still on disk, and `/subagents-worktrees` lists them on demand and removes one behind an explicit confirmation.
Package test count went from 31 to 62; the pre-completion reviewer returned **PASS** with no warnings.

### Observations

- **The tidy-first assessor corrected the plan's own count.**
  The plan said six inline `new WorktreeWorkspaceProvider(...)` constructions would break when the constructor gained a registry argument; the assessor counted seven.
  Extracting `makeProvider` first meant step 3 changed one signature instead of seven.
- **fallow loses a reference through a destructured object-literal property.**
  `makeProvider` initially returned `{ provider, live }`, and `pnpm fallow dead-code` then reported `WorktreeWorkspaceProvider.prepare` as an unused class member — a finding bisected to that exact commit and absent at the pre-change baseline.
  Returning the instance directly and taking the registry as a parameter restored the reference.
  Worth remembering: a test helper that wraps a class instance in an object literal can manufacture a dead-code finding for a method that is plainly called.
- **Rule 3 ("under the resolved temp root") needed a test location outside `tmpdir()`.**
  Every fixture in this package lives under `tmpdir()`, so the exclusion half of that rule had nowhere to be exercised.
  The test creates its scratch worktree under `node_modules/.pi-wt-outside` — outside the temp root on every platform, and gitignored, so a leftover from a failed run never reaches the working tree.
- **The inclusion half of the realpath rule is pinned by an ordinary test.**
  "Reports the rescue worktrees left on disk" asserts the resolved paths; comparing against an unresolved `tmpdir()` makes it return `[]` on macOS, so the planning measurement is now a regression test rather than a note.
- **`formatPreservedNotice` was written in step 2 and immediately removed.**
  It arrived with the module but belonged to step 4, where its tests live; deleting it and re-adding it one step later kept every export consumed and tested in the commit that introduced it.
- **Deviations from the plan.**
  `AGENT_WORKTREE_PREFIX` is now exported from `src/worktree.ts` so `createWorktree` and the scan share one `pi-agent-` literal — the plan did not list it.
  `test/support/git-fixture.ts` was left untouched; the existing `initGitRepo`/`installPreCommitHook`/`lockGitIndex` helpers covered the new suites.
  Two `test:` commits were added beyond the plan's six steps.
- Pre-completion reviewer: **PASS**, no WARN findings.
  It independently verified all four Goals against the code, the commit grammar, and that the two Open Questions were deliberately-deferred alternatives rather than unfiled follow-ups.

## Stage: Final Retrospective (2026-08-10T20:23:38Z)

### Session summary

All three stages — planning, TDD, and ship — ran in one session, taking this issue from a body that said "I have not settled on the surface" to a released `pi-subagents-worktrees` v0.3.0.
The shipped feature warns at session start about rescue worktrees a failed cleanup left on disk and adds `/subagents-worktrees` to inspect or remove them, closing the visibility loop [#704] deliberately left open.
No user corrections and no rework across the whole session; the one notable friction was a fallow false positive manufactured by a test helper.

### Observations

#### What went well

- **Measuring before offering options changed the option set, not just the plan.**
  Four mechanisms were probed at planning time: `git worktree list --porcelain` prints resolved paths (`/private/var/…` vs. `tmpdir()`'s `/var/…`), `git worktree lock --reason` survives even `remove --force`, Pi substitutes `noOpUIContext` for a headless session, and extension factories run per session rather than per process.
  Two of those killed designs I would otherwise have written: the naive `startsWith(tmpdir())` filter that finds nothing on macOS, and a "once per process" flag that cannot exist.
  The lock measurement lost the `ask_user` vote, and that is the point — the option set was honest about what each mechanism actually does.
- **The planning measurement became a regression test rather than a note.**
  "Reports the rescue worktrees left on disk" asserts resolved paths, so comparing against an unresolved `tmpdir()` turns the test red on macOS.
  A measurement that only lives in a plan decays; this one is now pinned.
- **The `git rev-parse` discipline from [#704]'s retro held.**
  That session fabricated two SHAs in a PR close comment and the fix landed in `.pi/prompts/ship-issue.md`.
  This session ran `git rev-parse a081cbf8` before writing the close comment and pasted the result — the same failure mode, one session later, did not recur.
- **Deleting code to keep a step honest.**
  `formatPreservedNotice` was written in TDD step 2 alongside the module it belongs to, then removed and re-added in step 4 where its tests live, so no commit shipped an export that was neither consumed nor tested.

#### What caused friction (agent side)

1. `other` — **A test helper returning `{ provider, live }` made fallow report `WorktreeWorkspaceProvider.prepare` as an unused class member.**
   The class declares `implements WorkspaceProvider` and the method is called in seven tests, but fallow cannot trace a call through a destructured object-literal property.
   Diagnosis took a checkout of the pre-change state plus a six-commit bisect loop to prove the finding was mine and to locate the commit that introduced it.
   Impact: one extra `test:` commit (`7516e614`) changing `makeProvider` to return the instance directly and take the registry as a parameter — which is better test design anyway.
2. **had no cheap answer.**
   `missing-context` — **`pnpm fallow dead-code` is not part of `/tdd-plan`'s green baseline, so "is this finding pre-existing?"**
   The baseline step runs `check`, `lint`, and `test` only; fallow first ran after the last TDD step, where a finding could equally have been pre-existing debt.
   Impact: two tool calls to establish the baseline retroactively (`git checkout <plan-commit> -- src test` → `fallow` → restore).
3. `missing-context` — **The plan asserted six `new WorktreeWorkspaceProvider(…)` constructions; there were seven.**
   The count came from reading the file rather than grepping it, and the `tidy-first-assessor` corrected it.
   Impact: none — the tidy commit consolidated all of them regardless.
4. `missing-context` — **The plan did not notice that every fixture in this package lives under `tmpdir()`, which left one designed rule untestable in the obvious way.**
   The "under the resolved temp root" exclusion needed a rescue-named worktree *outside* the temp root, and there is no such location among the existing fixtures.
   Solved during TDD by creating the scratch worktree under `node_modules/.pi-wt-outside` — outside the temp root on every platform, and gitignored, so a leftover from a failed run cannot reach the working tree.
   Impact: a few minutes and an unplanned test technique; no rework.

#### What caused friction (user side)

- Nothing blocking.
  The operator answered one three-part `ask_user` gate (notice channel, action surface, detection mechanism) and made no corrections across planning, TDD, and ship.
- One opportunity: all three answers picked the smallest option — toast over persisted message, slash command over agent tool, path heuristic over marker file or git lock.
  A gate that named the minimal-viable combination as an explicit recommendation would have carried the same information with less reading, since the richer options existed mainly to show they had been considered.

### Diagnostic details

- **Model-performance correlation** — both subagents ran `anthropic/claude-sonnet-5` per their frontmatter: `tidy-first-assessor` on preparatory-refactor design (which caught the seven-vs-six miscount) and `pre-completion-reviewer` on the quality gate.
  Both are judgment-heavy, so the assignment fits.
  The readable transcript covers the ship stage on `claude-sonnet-5` and this retrospective on `claude-opus-5`; the planning and TDD turns are not in the session file this tool can read, so no label is claimed for them.
- **Escalation-delay tracking** — no `rabbit-hole` findings.
  The longest single-problem sequence was the fallow diagnosis at four tool calls, and the six-commit bisect ran as one scripted loop rather than six probes.
- **Feedback-loop gap analysis** — `pnpm run check`, root `pnpm run lint`, and the package suite ran after every one of the eight implementation commits, and the full workspace suite before the pre-completion dispatch.
  The single gap is friction point 2: `pnpm fallow dead-code` ran only at the end.

### Changes made

1. `.pi/prompts/tdd-plan.md` — added `pnpm fallow dead-code` as a fourth green-baseline check, so a finding at the end of the session can be attributed to this change rather than investigated from scratch.
2. `.pi/skills/fallow/SKILL.md` — extended gotcha 6 with the test-helper case: a helper returning the instance inside an object literal hides its call sites the same way production object-literal wiring does, and the remedy is to return the instance directly rather than reach for a traced closure.

Proposed and deliberately rejected: a rule about testing a path-scope exclusion when every fixture lives under `tmpdir()` (too niche to this package), and a call-site counting rule for plans (the `testing` skill already prescribes grepping the bare callee).

[#704]: https://github.com/gotgenes/pi-packages/issues/704
