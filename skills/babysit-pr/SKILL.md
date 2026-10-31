---
name: babysit-pr
description: Watch a pull request until it is green and every review comment is handled. Waits for CI on the head commit with job_watch or job_start instead of polling, reads the logs of failed checks, reproduces and fixes failures with the repository's own checks, pushes the fix, answers or fixes review comments, and repeats until the PR is green or a stop condition hits. Use when asked to babysit, watch, shepherd, or "get this PR green", or right after opening a PR that should land without supervision.
---

# Babysit a pull request

Drive one pull request to green CI with every review comment handled, without
polling. The agent sleeps while CI runs: `job_watch` or `job_start` wakes it when
the checks finish, and the agent ends its turn in between.

## Input and setup

- The PR: a number or URL from the user, or the PR whose head is the current
  branch. Record `owner`, `repo`, the PR number, the head branch, and the **head
  commit SHA**.
- How you reach GitHub. Prefer the `gh` CLI when `gh auth status` succeeds. If the
  GitHub MCP tools (`mcp__github__*`) are connected instead, use those; their
  exact names and arguments are in `/system:tools`. If neither works, stop and say
  so.
- Whether you may push. You may push fixes to a branch you created in this
  session or that the user told you to work on. For anyone else's branch, ask
  first. Never push to the default branch.

Track the work with `todo`: one task per failing check or review thread, keyed
`pr<number>-<slug>`, so a reload or compaction loses nothing.

## 1. Wait for CI on the head commit

Watch the **head commit SHA**, never the PR number: a push moves the PR to a new
commit, and a wake-up for the PR could describe code you did not mean.

With `gh`, one shell watch covers every check on the commit. It succeeds once
checks exist and none is still queued or running:

```json
{
  "check": "gh api 'repos/OWNER/REPO/commits/SHA/check-runs?per_page=100' --jq '.total_count > 0 and ([.check_runs[] | select(.status != \"completed\")] | length == 0)' | grep -qx true",
  "intervalSeconds": 60,
  "timeoutSeconds": 3600,
  "label": "CI for PR NUMBER at SHA"
}
```

When a single workflow run carries everything, `job_start` with
`gh run watch RUN_ID --exit-status` is cheaper.

With the MCP tools only, list the check runs for the head commit, then start one
tool watch per check that is not yet completed:

```json
{
  "toolCheck": {
    "tool": "mcp__github__get_check_run",
    "args": { "owner": "OWNER", "repo": "REPO", "check_run_id": 123 },
    "match": { "path": "status", "equals": "completed" }
  },
  "intervalSeconds": 60,
  "timeoutSeconds": 3600,
  "label": "CHECK NAME at SHA"
}
```

Then **end your turn**. Do not poll, sleep, or call the check yourself while the
watch runs. Completions arrive as one follow-up message.

If no checks appear within a few minutes of the push, look at the workflow
triggers (`.github/workflows/`) before waiting longer: the change may not select
any job.

## 2. Triage the results

When woken, confirm the PR head is still the SHA you watched. If someone else
pushed, start again from step 1 with the new SHA and tell the user.

For every check that did not succeed:

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
5. Record the fix on the check's task, then go back to step 1 with the new SHA.

Give each check at most three fix attempts. After that, stop and report what you
tried and what you saw.

## 4. Handle review comments

Read the review threads and top-level comments once CI is settled, and again
after each push.

- A comment asking for a change within the PR's scope: make it, verify it as in
  step 3, push, and reply briefly with what changed and the commit.
- A suggestion that is wrong or out of scope: reply once with the reason. Do not
  argue twice; leave it for the user.
- A larger ask (a redesign, new scope): do not do it. Reply that it needs the
  author's decision and tell the user.
- A question: answer it from the code, with `file:line`.

Never resolve someone else's thread on their behalf, and never approve or merge.

## 5. Finish

Stop when every check on the head commit succeeded and no review thread is
waiting on you. Report:

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
- Keep watching through `job_watch`/`job_start`. A turn that waits in the
  foreground or polls in a loop wastes the session.
