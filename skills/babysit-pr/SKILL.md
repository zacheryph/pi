---
name: babysit-pr
description: Watch a pull request until it is green and every review comment is handled. Waits for CI, pushes and reviews with git_pr_watch instead of polling, reads the logs of failed checks, reproduces and fixes failures with the repository's own checks, pushes the fix, answers or fixes review comments, and repeats until the PR is green or a stop condition hits. Use when asked to babysit, watch, shepherd, or "get this PR green", or when delegated ownership of CI and review follow-ups for a PR.
---

# Babysit a pull request

Drive one pull request to green CI with every review comment handled, without
polling. The agent sleeps while CI runs: `git_pr_watch` wakes it when the checks
finish, someone pushes or reviews, or the PR is merged or closed, and the agent
ends its turn in between. This works in both a main session and a delegated worker: an open watch keeps the worker waiting and its report wakes it through the normal concurrency limit.

## Input and setup

- The PR: a number or URL from the user, or the PR whose head is the current
  branch. Read it with `git_pr_status { pr }`: it returns the head branch
  (`headRef`), the **head commit SHA** (`headSha`), state, review decision and
  check counts, through `gh` or the GitHub MCP tools, whichever works, and
  records the PR in the session's ledger. Record `owner`, `repo`, the PR
  number, the head branch and the head SHA. If it fails because neither `gh`
  nor a GitHub MCP reader is available, stop and say so.
- How you reach GitHub for everything else (failed logs, reruns, review
  threads, replies). Prefer the `gh` CLI when `gh auth status` succeeds. If the
  GitHub MCP tools (`mcp__github__*`) are connected instead, use those; their
  exact names and arguments are in `/system:tools`.
- Whether you may push. You may push fixes to a branch you created in this
  session or that the user told you to work on. For anyone else's branch, ask
  first. Never push to the default branch.

A delegator may hold the watch itself and hand you only what a report named
(failed checks, review comments, a conflict). Then skip step 1 and do not call
`git_pr_watch`: do steps 2 to 4 for what you were handed, push, report the new
head SHA and finish. The delegator's watch tells it what happens next. On a
branch this session created you may resolve a conflict by rebasing onto the
base and pushing with `--force-with-lease`.

Track the work with `todo_upsert`: one task per failing check or review thread, keyed
`pr<number>-<slug>`, so a reload or compaction loses nothing. After a reload,
`git_pr_list` names the PRs this session opened and `git_pr_status` reads them
again. When tasks were handed to you with handoff.todo, update their messages and leave them in_progress; the delegator accepts and completes them after verification. At finish, report the exact head SHA, checks and unresolved review items.

## 1. Wait for CI on the head commit

Call `git_pr_watch { pr }` and **end your turn**. It reads the PR on a timer,
through `gh` or the MCP tools alike, and wakes you with a message when checks
finish on the head. The message names the head SHA the result is for and the
checks that failed. Do not poll, sleep, or call `git_pr_status` yourself while
the watch runs.

- It also reports, without ending, a head that moved (someone pushed), a changed
  review decision, new reviews or comments, and new conflicts with the base. It
  ends when the PR is merged or closed, or at its timeout (two hours unless you
  pass `timeoutSeconds`).
- If it answers that checks already finished, it does not watch: go to step 2
  with the status it returned. If the head it names is not the commit you just
  pushed, GitHub has not caught up; call it again.
- After you push or reply on the PR, call `git_pr_watch` again before ending
  your turn. The same watch continues from the status it returns, so your own
  push and replies are not reported back to you.
- The watch survives a reload or resume. If a message says it was lost or could
  no longer read the PR, read the PR with `git_pr_status` and call
  `git_pr_watch` again if it still needs watching. `git_pr_list` shows which
  PRs are watched.

When a single workflow run carries everything, `job_start` with
`gh run watch RUN_ID --exit-status` works too.

If no checks appear within a few minutes of the push, look at the workflow
triggers (`.github/workflows/`) before waiting longer: the change may not select
any job.

## 2. Triage the results

The message that woke you says which head the checks finished on. If it is not
the SHA you pushed (it also reports `Head moved` when someone else pushed), tell
the user, treat the new head as the one to get green, and wait again from
step 1. If every check passed, CI is green; go to step 4.

Otherwise the message names the failed checks; `gh pr checks NUMBER` (or the
MCP check runs for the head SHA) has their runs. For every check that did not
succeed:

1. Read its failing log: `gh run view RUN_ID --log-failed`, or the MCP job-logs
   tool. Find the first real error, not the last line.
2. Classify it:
   - **Caused by the PR**: a failing test, type error, lint error, or build
     break in or because of the changed code. Fix it (step 3).
   - **Infrastructure**: runner lost, network timeout, rate limit, an action
     that failed to download. Re-run only the failed jobs once
     (`gh run rerun RUN_ID --failed`), then wait again. A second identical
     failure is no longer infrastructure.
   - **Pre-existing**: the same check fails the same way on the base branch.
     Do not fix it in this PR; record it on the task and tell the user.

## 3. Fix a failure

1. Reproduce it locally with the same command CI runs (read the workflow file for
   it), and see it fail. If it will not reproduce, say so and check environment
   differences (runtime version, missing service) before changing code.
2. Make the smallest change that addresses the cause. Keep it to what the failure
   needs; no unrelated cleanup.
3. Run the same command again and see it pass, plus the repository's fast checks
   for what you touched.
4. Commit with a message naming the check that failed, following the
   repository's commit rules, and push to the PR branch.
5. Record the fix and new SHA on the check's task, then go back to step 1. Earlier CI or reviewer evidence does not accept the new revision; rerun the affected verification and report its SHA to the delegator.

Give each check at most three fix attempts. After that, stop and report what you
tried and what you saw.

## 4. Handle review comments

Read the review threads and top-level comments once CI is settled, again after
each push, and when a watch reports new reviews or comments. To be woken for
reviews that arrive after CI is green, watch with `until: "merged"`.

- A comment asking for a change within the PR's scope: make it, verify it as in
  step 3, push, and reply briefly with what changed and the commit.
- A suggestion that is wrong or out of scope: reply once with the reason. Do not
  argue twice; leave it for the user.
- A larger ask (a redesign, new scope): do not do it. Reply that it needs the
  author's decision and tell the user.
- A question: answer it from the code, with `file:line`.

Never resolve someone else's thread on their behalf, and never approve or merge.

## 5. Finish

Stop when `git_pr_status` shows the head SHA you pushed with `ciDone` true and
no failed checks, and no review thread is waiting on you. Report:

- the final head SHA and its check results;
- each fix with its commit, and each rerun with its reason;
- review comments handled, and those left for the user;
- anything pre-existing or out of scope that you noticed.

Also stop, and report the same way, when:

- a check still fails after three attempts;
- a fix would need a decision only the user can make;
- the base branch moved and the PR now conflicts. Do not rebase or force-push a
  branch you did not create; ask.

## Rules

- Never skip, disable, mark flaky, or weaken a test or check to get green.
- Never push an empty commit, or close and reopen the PR, to start CI again.
- Never rewrite history on a branch someone else pushes to.
- One concern per commit. A fix commit contains only that fix.
- Keep waiting through `git_pr_watch`. A turn that waits in the foreground or
  polls in a loop wastes the session.
