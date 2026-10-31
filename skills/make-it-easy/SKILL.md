---
name: make-it-easy
description: Turn a project or goal into implementation roadmap options built on "make the change easy, then make the easy change". Finds the true goal, lists the inputs the new work needs and how to supply them decoupled, researches what already exists, finds the friction worth changing first (refactor, reorganize, simplify, add a seam), and produces 2-3 genuinely different ordered roadmaps with a recommendation. Use when planning a feature, project, migration, or integration; when asked for a roadmap, plan options, or "how should we approach this"; or before implementing anything large enough that the first idea may not be the cheapest path. Plans only; does not implement.
---

# Make it easy

> "For each desired change, make the change easy (warning: this may be hard),
> then make the easy change." — Kent Beck

The goal is not a plan for building new things. It is a plan for making the new
thing small by changing what is already there: supply its inputs through
decoupled contracts, remove the friction in its way, and only then add it.
Existing code, config, and infrastructure are fair game when changing them makes
the new work easier. They are not fair game for their own sake.

## Output

One roadmap document per goal (template: `references/roadmap-template.md`),
written to `docs/roadmaps/<slug>.md` unless the project already keeps plans
elsewhere. It records the goal brief, the input table, the friction map, the
options considered, the chosen roadmap, and open questions. Write it
incrementally, one phase at a time, so a stopped session loses nothing.

`references/example-load-balancer-xrd.md` walks one real-shaped case through every
phase. Read it if the phases feel abstract.

Plan only. Do not start implementing. At the end offer to turn the steps into
todos with the `todo` tool.

## Scale to the task

A one-file change needs a paragraph, not seven phases. Run the full workflow
when the work touches several components, crosses ownership boundaries, or when
the obvious approach would hardcode, duplicate, or couple something. For small
work, run phases 1-3 in your head, state the result in a few lines, and show
only the options that differ. Say which mode you chose and why.

## Workflow

Each phase has a gate. Do not pass it until the output exists. Read the
reference file when you enter the phase, not before.

### 1. True goal — `references/goal-discovery.md`

Separate the stated request from the outcome it serves. Look at the code first
and ask the user only what the code cannot tell you. Gate: a confirmed goal
brief with success criteria, non-goals, constraints, and an explicit statement
of what existing things may be changed.

### 2. Inputs — `references/inputs-and-contracts.md`

List everything the new work must know or receive to do its job: where it lives,
what it attaches to, configuration, identity, policy, data shape, lifecycle
signals. For each input find where it comes from today and design how it should
be supplied so producer and consumer stay decoupled. Gate: every input has a
source, an owner, and a recommended way to supply it, with the decoupling
tradeoff stated.

### 3. What exists — `references/friction-survey.md`

Research the territory the inputs and the change touch: what already does part
of this, which conventions to follow, and what resists the change. Record
friction with evidence (`file:line`), what it blocks, and a verdict: fix first,
work around, or leave. Gate: every "fix first" traces to an input or to the
change itself, and nothing is on the list only because it is ugly.

### 4. Options — `references/roadmap-options.md`

Produce two or three roadmaps that differ in strategy, not in size. Always
include the least-preparation baseline so the cost of preparing is visible.
Compare them honestly, recommend one, and let the user choose or merge. Gate:
the user has picked a direction.

### 5. Detail the chosen roadmap

Expand it into ordered steps using the step format in
`references/roadmap-template.md`. Keep behavior-preserving tidying separate from
behavior changes. The last step is the easy change itself. If that step is still
large or has open questions, the roadmap is not done: return to phase 3.

### 6. Hand off

Save the document, list open questions, and stop. Mention which step to start
with and whether it can ship alone.

## Asking the user

- Investigate before asking. Never ask what the repo, config, or docs answer.
- Batch independent questions, each with your recommendation and a one-line
  reason. Hold dependent questions for the next round.
- If a `questionnaire` tool is available (it ships with
  `@firstpick/pi-extension-grill-me`), use it for each batch of choices.
  Otherwise ask in chat, at most four questions at a time.
- `/grill-me` overlaps with phase 1 only. If the user has already run it and a
  `GRILL-ME.md` (or `.pi/grill-me/state.json`) exists, treat its decisions as
  answered input to the goal brief and ask only what is missing. Do not call the
  `grill_*` tools; the roadmap document is the record.
- Never ask for secrets or credentials.

## Delegation

Fan phase 3 recon out to read-only `Explore` subagents, one per input or
component. Ask each for evidence with `file:line` and a short conclusion, not
file dumps. Have them return large findings as `stash_put` handles, and keep
the handles in the document.

## Rules that keep the plan honest

- Every preparatory step names the later step it makes easier. No named
  beneficiary, no step.
- Preparation has a price. If preparing costs more than doing the change the
  hard way and nobody will touch this area again, say so and recommend the
  baseline.
- Contracts earn their indirection only when producer and consumer have
  different owners or rates of change, or there is more than one of either.
  One producer, one consumer, one owner: pass a parameter.
- Options must be different strategies. The same plan at three sizes is one
  option.
- Prefer orderings where each step ships value or removes risk. A roadmap that
  delivers nothing until its last step is a bet; label it as one.
- Say what you did not verify. A friction claim without evidence is a guess.
