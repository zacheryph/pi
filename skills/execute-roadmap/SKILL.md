---
name: execute-roadmap
description: Carry out a chosen make-it-easy roadmap. Turns each step of docs/roadmaps/<slug>.md into a todo with its dependencies, delegates ready steps to subagents, verifies every step against its "Done when" and "Verification" lines with a separate worker, commits one step at a time, and keeps the roadmap document and the todo ledger in sync until the easy change lands or a step is blocked. Use when asked to execute, run, implement, or continue a roadmap, or right after make-it-easy hands off.
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

## Preconditions

Stop and say why, without creating todos, when:

- `Status:` is `draft`, or the document has no `## Decision`. The user has not
  chosen an option yet; offer to finish make-it-easy phase 4.
- An entry under `## Open questions` blocks the first step you would run. Ask it.
- The working tree has uncommitted changes you did not make. Ask whether to
  commit, stash, or stop.

## 1. Build the ledger

Call `todo` with `action: "list"` first. If tasks for this roadmap already exist
(same key prefix), this is a resume: reconcile instead of re-creating.

One todo per roadmap step, created with a single sparse `upsert`, never `replace`:

| Todo field | From the step |
|---|---|
| `key` | `<prefix>-<n>`, where `<prefix>` is a short form of the slug (`lb-xrd-3`). Must match `^[a-z0-9][a-z0-9._-]{0,39}$`. |
| `subject` | The step heading (verb phrase), up to 160 characters. |
| `description` | `Type`, `Does`, `Done when`, `Verification`, `Rollback`, and `Roadmap: docs/roadmaps/<slug>.md step <n>`. Up to 2,000 characters; cut `Does` first, never `Done when` or `Verification`. |
| `dependsOn` | The step's `Depends on`, mapped to keys. Steps without one depend on nothing. |

Also add one task, `<prefix>-done`, that depends on every step: "Roadmap
complete: update document status". The ledger holds at most 50 tasks; a roadmap
longer than that is not one roadmap, so stop and say so.

Set the document's `Status:` to `in progress` and update its `Updated:` date.

## 2. Run ready steps

A step is ready when it is `pending` and every `dependsOn` is `completed`. For
each ready step:

1. Mark it `in_progress`.
2. Spawn a worker. Use `general-purpose` for implementation, `Explore` for a
   step that only investigates, `Plan` for a step that only designs. The brief
   is the step itself, plus:
   - the task key and the roadmap path, so the worker can read context;
   - the step's file scope, and the files other running workers own;
   - "Do not edit the todo list or the roadmap document; report back instead";
   - the report shape: outcome, changed files, verification run and its result,
     anything the step did not anticipate. Large output as a `stash_put` handle.
3. Record the agent ID on the task with a `message`.

Run independent ready steps in parallel (`run_in_background`) only when their
file scopes do not overlap. When unsure, run them one at a time. Never run a
tidy step and a behavior step on the same files at once.

## 3. Verify each step

A worker finishing is not proof. For every implementation step:

1. Read the worker's report. If it changed files outside its scope, treat the
   step as failed.
2. Spawn a **separate** worker to verify it, read-only where the step allows.
   Give it the step's `Done when` and `Verification` lines and the diff
   (`git diff` against the step's starting commit). Ask for pass or fail per
   line, with evidence.
3. On pass: commit (see below), then mark the task `completed` with a `message`
   that names the commit and the evidence.
4. On fail: resume the original worker (`subagent` with `resume` set to its
   agent ID) with the verifier's findings. Allow two repair rounds. After that,
   the step is blocked: mark it `pending`, record the failure in its `message`,
   and stop dispatching anything that depends on it.

The repository's own fast checks (`npm run check`, the touched workspaces'
tests) run in every verification, whether or not the step lists them.

## 4. Commit and record

- One commit per step, in roadmap order. Its subject is the step heading; its
  body names the roadmap and step number. Follow the repository's commit rules
  (for this repository: `git -c commit.gpgsign=false commit`).
- Never combine a tidy step and a behavior step in one commit.
- Do not push or open pull requests unless the user asked for it. If they did,
  default to one branch for the roadmap and one pull request per step that
  `Ships alone: yes`.
- In the roadmap document, add a line under the step:
  `**Landed:** <short sha> · <date>`.

## 5. When the plan is wrong

Workers will find things the roadmap did not. Classify each finding:

- **Inside the step** (a missed call site, a test to update): the worker handles
  it within the step.
- **New friction or a wrong assumption**: do not improvise a new plan. Mark the
  step `pending`, add the finding to `## Open questions` with evidence, and stop.
  Offer to return to make-it-easy phase 3 for the affected steps only.
- **Unrelated** (noticed, not needed): add it to `Noticed, not doing` and carry on.

## 6. Finish or stop

When `<prefix>-done` is ready, set the document's `Status:` to `done`, complete
the task, and report: steps landed with their commits, verification evidence,
anything noted for later.

When you stop early (blocked, limit reached, a question), leave the ledger and
the document consistent and report:

- which steps landed, which is blocked and why, which are ready next;
- the agent IDs worth resuming;
- the exact question or decision you need from the user.

Resuming later is the same skill: step 1 reconciles the existing tasks with the
document's `Landed:` lines and continues from the first unfinished step.

## Rules

- The roadmap document wins. If the ledger and the document disagree, fix the
  ledger to match the document, unless a `Landed:` line or a commit proves
  otherwise.
- Never mark a step `completed` without a passing verification and a commit.
- Never skip, disable, or weaken a test to make a step pass.
- Ask the user only for decisions the roadmap and the code cannot answer.
