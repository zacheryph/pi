---
name: execute-roadmap
description: Carry out a chosen make-it-easy roadmap. Turns each step of docs/roadmaps/<slug>.md into a todo with its dependencies, delegates ready steps to subagents, verifies every step against its "Done when" and "Verification" lines with a reviewer that did not do the work, and lands it either as local commits or as pull requests. With pull requests it gets each one green, notifies the user when it is ready for review, waits for the merge, verifies the deploy where the repository has a way to, and only then starts the steps that depend on it. Keeps the roadmap document and the todo ledger in sync until the easy change lands or a step is blocked. Use when asked to execute, run, implement, deliver, ship, or continue a roadmap, or right after make-it-easy hands off.
---

# Execute a roadmap

make-it-easy plans; this skill carries the plan out. The roadmap document is the
plan of record, the `todo` ledger tracks progress, and subagents do the work. You
coordinate: you do not write the code yourself unless a step is trivial.

## Input

A roadmap written by make-it-easy, usually `docs/roadmaps/<slug>.md`. If the user
names none, list `docs/roadmaps/` and pick the one whose `Status:` is `chosen` or
`in progress`; ask only if more than one qualifies.

Optional limits from the user: "through step N", "only the Make it easy steps",
or "stop before the change". Without one, run until the last step lands or you
are blocked.

## Delivery

How a step lands, and so when it is done, is one choice for the whole run:

| Delivery          | A step lands as                                           | A step is done when                                                    |
| ----------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Local**         | one commit on the roadmap branch (section 4)              | its verification passed and the commit exists                          |
| **Pull requests** | one or more pull requests someone else merges (section 5) | every one is merged and its deploy is verified, where that is possible |

Use pull requests when the user says to deliver, ship, push or open pull
requests, or when the ledger of a resumed run says so. If the user said
neither, ask once with `ask` (Local first). Record the choice in the
description of `<prefix>-done`, so a resumed run does not ask again.

Under either delivery the steps that depend on a step start only once it is
done. With pull requests that means after the merge and the deploy check, not
after the commit.

## Preconditions

Stop and say why, without creating todos, when:

- `Status:` is `draft`, or the document has no `## Decision`. The user has not
  chosen an option yet; offer to finish make-it-easy phase 4.
- An entry under `## Open questions` blocks the first step you would run. Ask it.
- The working tree has uncommitted changes you did not make. Ask whether to
  commit, stash, or stop.

## 1. Build the ledger

Call `todo_list` first. If tasks for this roadmap already exist
(same key prefix), this is a resume: reconcile instead of re-creating.

One todo per roadmap step, created with a single sparse `todo_upsert`, never `todo_replace`:

| Todo field    | From the step                                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`         | `<prefix>-<n>`, where `<prefix>` is a short form of the slug (`lb-xrd-3`). Must match `^[a-z0-9][a-z0-9._-]{0,39}$`.                                                                     |
| `subject`     | The step heading (verb phrase), up to 160 characters.                                                                                                                                    |
| `description` | `Type`, `Does`, `Done when`, `Verification`, `Rollback`, and `Roadmap: docs/roadmaps/<slug>.md step <n>`. Up to 2,000 characters; cut `Does` first, never `Done when` or `Verification`. |
| `dependsOn`   | The step's `Depends on`, mapped to keys. Steps without one depend on nothing.                                                                                                            |

Also add one task, `<prefix>-done`, that depends on every step: "Roadmap
complete: update document status". The ledger holds at most 50 tasks; a roadmap
longer than that is not one roadmap, so stop and say so.

A step's task carries its stage as its `message`, rewritten at each change, so
the ledger always says where the step is and who it waits on:
`implementing (agent <id>)`, `in review`, `checks running: <url>`,
`waiting on the user: review <url>`, `merged <sha>, verifying deploy`. There is
no blocked or waiting status: a step that waits on a pull request stays
`in_progress`.

Set the document's `Status:` to `in progress` and update its `Updated:` date.

## 2. Run ready steps

A step is ready when it is `pending` and every `dependsOn` is `completed`. For
each ready step:

1. Mark it `in_progress`.
2. Spawn a worker. Use `general-purpose` for implementation, `explore` for a
   step that only investigates, `plan` for a step that only designs. The brief
   is the step itself, plus:
   - the task key and the roadmap path, so the worker can read context;
   - the step's file scope, and the files other running workers own;
   - "Do not edit the todo list or the roadmap document; report back instead";
   - the report shape: outcome, changed files, verification run and its result,
     anything the step did not anticipate. Large output as a `stash_put` handle.
3. Record the agent ID on the task with a `message`.

Subagents always run in the background: after starting the ready steps' workers,
end your turn, and each completion message wakes you to verify that step. A
completion message carries only the first 500 characters of a result, so the
report's large output arrives as a `stash_put` handle that you read with
`stash_get`.

Run every ready step, in parallel when there are several. With pull-request
delivery a step always gets a worktree (section 5 says from where). With local
delivery a single ready step runs in the main checkout, and several ready at
once each get their own worktree:

- Create it with `git_worktree_create`, branch `<key>` (the task key), from the
  roadmap branch's current `HEAD` (with pull requests, from the remote default
  branch: section 5). A step that spans repositories gets one
  worktree per repository with the same `workspace`.
- Pass the returned path as `subagent_start`'s `cwd`, and record the path and
  branch on the task with a `message`.

With local delivery, worktrees let parallel steps touch the same files; they
may then conflict when they land (section 4). With pull requests, steps whose
files overlap do not run in parallel at all (section 5). Either way, never run
a tidy step and a behavior step on the same files at once.

## 3. Verify each step

A worker finishing is not proof. For every implementation step:

1. Read the worker's report. If it changed files outside its scope, treat the
   step as failed.
2. Spawn a `review` (never the worker that implemented the step). Give it the
   task key, the step's `Done when` lines as its acceptance criteria, the
   `Verification` lines as the checks to run, and the diff range (the step's
   starting commit to the working tree). A step that ran in a worktree is
   reviewed there: pass the same `cwd`.
3. On `Verdict: PASS`: commit (section 4). With local delivery, mark the task
   `completed` with a `message` that names the commit and the reviewer's
   evidence. With pull requests, record the same and go on to section 5; the
   task stays `in_progress`.
4. On `Verdict: FAIL`: send the original worker the reviewer's findings with
   `subagent_send` (its agent ID and the findings as the message), then review again. Allow two
   repair rounds. On `Verdict: BLOCKED`, fix what kept the reviewer from checking
   (a missing service, a check that cannot run) or ask the user. After that,
   the step is blocked: mark it `pending`, record the failure in its `message`,
   and stop dispatching anything that depends on it.

The repository's own fast checks (`npm run check`, the touched workspaces'
tests) run in every verification, whether or not the step lists them.

## 4. Commit and record

- One commit per step, in roadmap order. Its subject is the step heading; its
  body names the roadmap and step number. Follow the repository's commit rules
  (for this repository: `git -c commit.gpgsign=false commit`).
- Never combine a tidy step and a behavior step in one commit.
- With local delivery, a step that ran in a worktree is committed there, on its
  branch, then landed on the roadmap branch in roadmap order with
  `git cherry-pick`. Hold a later step's commit in its worktree until every
  earlier step has landed. If the pick conflicts, rebase the step's branch onto
  the roadmap branch, send its worker the conflict with `subagent_send` (it
  keeps its `cwd`) to resolve, and verify again before landing. Once it has
  landed, remove the worktree with `git_worktree_remove` (its branch is kept;
  delete it with `git branch -d`). Do not push.
- In the roadmap document, add a line under the step when it lands:
  `**Landed:** <short sha> · <date>`, and with pull requests
  `**Landed:** <PR URL> · <merge sha> · <date>` once it is merged.

## 5. Deliver as pull requests

Skip this section with local delivery.

### What goes in a pull request

- A step that `Ships alone: yes` is one pull request.
- A step that says it opens several (one per package, per repository, per
  file) is that many, each on its own branch and worktree. The step is done
  when all of them are.
- A step that `Ships alone: no` shares the pull request of the step it cannot
  ship without: the one its reason names, otherwise the next step. One commit
  per step, in roadmap order. Their tasks move together.

### Branches and parallel work

Every pull request branches from the default branch as it is on the remote when
its work starts: create the worktree with `base: "origin/<default>"`, and have
the worker run `git fetch origin` and `git rebase origin/<default>` before its
first edit. Never stack one pull request on another's branch.

Two pull requests can be open at once when neither's step depends on the
other's and their file scopes do not overlap. Open all of those together: a
step that opens twenty one-file pull requests opens twenty. Steps that touch
the same files without a `Depends on` between them go one at a time, in roadmap
order. A dependent step waits for the merge, so it starts from a default branch
that already holds what it builds on.

One session watches at most `maxWatches` pull requests (pi-git's setting,
default 10). When a step has more, open them in waves of that size and tell the
user the setting exists.

### From commit to merge

For each pull request, after its steps pass section 3:

1. **Open it.** The step's worker pushes the branch and opens the pull request:
   the title is the step heading, the body names the roadmap and step and
   follows the repository's template. Record the URL in the task's `message`.
2. **Watch it.** Call `git_pr_watch { pr, until: "merged", timeoutSeconds: 86400 }`
   and end your turn. You hold every watch of the run: a watch in the main
   session survives a reload, and one owner hears everything. Do not let a
   worker start its own.
3. **Get it green.** When a report names failed checks, new reviews or
   comments, or a conflict with the base, send the worker that wrote the change
   the report with `subagent_send` and tell it to handle that with the
   babysit-pr skill while you keep the watch. It reports the new head SHA. The
   report that follows (`Head moved`) is that push. A changed head voids the
   earlier review for what changed: review that again before you treat the
   pull request as ready. A worker may rebase and force-push with lease the
   branch it created.
4. **Hand it to the user.** When checks are green on the head and no review
   thread waits on the worker, call `user_notify` with the pull request and
   what it is ("PR 12 ready for review", the URL and the step), set the stage
   to `waiting on the user: review <url>`, and end your turn. Once per pull
   request and head. For a step with many pull requests send one notification
   when all of them are green, naming the count and the step, not one each.
5. **Wait for the merge.** You never approve, merge, or turn on auto-merge. The
   user merges, or their auto-merge does; the watch reports `Merged.` either
   way. Review comments that arrive meanwhile go back to step 3.
6. **Keep the watch alive.** A review can take days. When a watch reports that
   it timed out, was lost, or can no longer read the pull request, and the
   step is still open, read it with `git_pr_status` and watch again. Do the
   same for every open pull request after a restart.

A pull request closed without merging is the user's decision, and you do not
know why: set the step `pending` with that in its `message`, start nothing
that depends on it, and ask.

### After the merge

1. Remove the worktree with `git_worktree_remove`, and add the `Landed:` line.
2. **Verify the deploy, when the repository has a way to.** Look for it in this
   order: a skill whose description covers verifying a deploy or release of
   this repository; deploy instructions in the repository's agent instructions
   (`AGENTS.md`, `CLAUDE.md`); a post-merge check the step's `Verification`
   lines name. Give the first one found to a worker with the merge SHA. The
   worker turns it into a `job_watch` check that passes only when that
   revision is live and healthy, ends its turn, and reports the result with
   its evidence. A check still pending at `job_watch`'s four-hour limit is
   started again, not counted as a failure.
3. If there is no such way, do not invent one. Record
   `deploy not verified: no method for this repository` on the task and treat
   the step as done at the merge. List these in the final report.
4. When several pull requests of one step merge close together, one check
   against the newest merge covers them if the method checks the deployed
   revision.
5. **Passed:** mark the task `completed` with the merge SHA and the evidence.
   Its dependents are now ready (section 2).
6. **Failed: hold the line.** Start no new step and open no new pull request,
   anywhere in the roadmap. Work already running finishes its current run and
   pull requests already open stay open. Call `user_notify` with what failed,
   then stop and report the evidence and the step's `Rollback` line. Never
   revert, and never open a revert pull request: that is the user's call.

## 6. When the plan is wrong

Workers will find things the roadmap did not. Classify each finding:

- **Inside the step** (a missed call site, a test to update): the worker handles
  it within the step.
- **New friction or a wrong assumption**: do not improvise a new plan. Mark the
  step `pending`, add the finding to `## Open questions` with evidence, and stop.
  Offer to return to make-it-easy phase 3 for the affected steps only.
- **Unrelated** (noticed, not needed): add it to `Noticed, not doing` and carry on.

## 7. Finish or stop

When `<prefix>-done` is ready, set the document's `Status:` to `done`, complete
the task, check `git_worktree_list` for worktrees this run left behind, and
report: steps landed with their commits or pull requests, verification evidence,
merges whose deploy was not verified and why, anything noted for later.

When you stop early (blocked, limit reached, a question), leave the ledger and
the document consistent and report:

- which steps landed, which is blocked and why, which are ready next;
- the agent IDs worth resuming, and the worktree each step's work is in;
- the pull requests still open, and which of them wait on the user;
- the exact question or decision you need from the user.

When you stop because only the user can move things on (a question, a blocked
step, a failed deploy check) and they may not be watching, call `user_notify`
first. A stop at a limit the user set needs none.

Resuming later is the same skill: step 1 reconciles the existing tasks with the
document's `Landed:` lines and continues from the first unfinished step. With
pull requests, also call `git_pr_list` and `git_pr_status`: a pull request that
merged while nothing was watching goes to "After the merge", and an open one is
watched again.

## Rules

- The roadmap document wins. If the ledger and the document disagree, fix the
  ledger to match the document, unless a `Landed:` line or a commit proves
  otherwise.
- Never mark a step `completed` without a passing verification and a commit;
  with pull requests, not before the merge and the deploy check.
- Never approve or merge a pull request, and never revert a merged one.
- Never skip, disable, or weaken a test to make a step pass.
- Ask the user only for decisions the roadmap and the code cannot answer.
