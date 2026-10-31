# Roadmap document template

Write to `docs/roadmaps/<slug>.md` unless the project keeps plans elsewhere.
Fill it phase by phase and keep every section short.

```markdown
# <Goal as a short noun phrase>

Status: draft | chosen | in progress | done · Updated: <date>

## Goal brief

<from goal-discovery.md>

## Inputs

<table from inputs-and-contracts.md, plus a contract sketch for each
discoverable input>

## What exists

**Prior art:** <what is reusable>
**Conventions to follow:** <list>
**Friction:** <table from friction-survey.md>
**Noticed, not doing:** <list>
**Not examined:** <list and why>

## Options

<option cards, comparison, recommendation>

## Decision

<chosen option, who decided, what was merged or changed, date>

## Roadmap

<ordered steps, format below>

## Open questions

<unowned inputs, unverified claims, decisions that block a step>
```

## Step format

Group steps as **Make it easy** (preparation), **The change**, and **Clean up**.
Number them in the order they should land.

```markdown
### <n>. <Verb phrase: the outcome>

**Type:** tidy (behavior-preserving) | contract | migration | the change | cleanup
**Eases:** <step or friction this exists for> _(required for any step before the change)_
**Does:** <what changes, with the files, resources, or components involved>
**Seam or contract:** <introduced or relied on, if any>
**Done when:** <observable, checkable>
**Verification:** <tests, characterization checks, plan or diff to inspect>
**Ships alone:** yes | no, because …
**Rollback:** <how to undo>
**Depends on:** <steps> · **Size:** S | M | L
```

## Rules for good steps

- Tidying and behavior changes never share a step. Each can land and be
  reverted on its own.
- A step is small enough to review in one sitting. Split anything labeled L
  unless it cannot be divided, and then say why.
- The step before the change should leave the change describable in a few
  sentences with no open questions and few places to edit. That is the test of
  "easy". If it fails, add preparation or return to phase 3.
- A characterization step (pinning current behavior with a test or check)
  belongs before any refactor that lacks a safety net.
- Contract steps list the retrofit of existing producers explicitly.
- Cleanup removes scaffolding, flags, and the old path. Cleanup that nobody owns
  does not happen, so give it a step.
- Name the first step to start with and whether it is safe to start today.
