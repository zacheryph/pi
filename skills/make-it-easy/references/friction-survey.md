# Phase 3: What exists and what resists

Research the territory before choosing a strategy. Two questions: what is already
here that does part of the job, and what will make the change hard?

## Survey

Cover, with evidence for each claim:

1. **Prior art.** Does something already do all or part of this? Prefer
   extending or renaming it over adding a parallel one.
2. **Conventions.** Naming, layout, error handling, configuration style, test
   style, how similar features were built. The new work should look native.
3. **Touchpoints.** Every place the change and each input will touch. Follow
   callers, config, deployment, docs, and tests, not only the obvious file.
4. **Ownership.** Who owns each touchpoint, and which are outside this repo.
5. **Safety net.** What tests, checks, or previews would catch a break in each
   touchpoint. Missing coverage is itself friction.
6. **History.** Recent churn and past attempts in the area (`git log`, issues).
   They show what hurts and what was tried.

Delegate wide sweeps to read-only `Explore` subagents.

## Friction

Friction is anything that would make the change or an input's supply larger,
riskier, or more surprising than it needs to be. Look for:

| Smell                                   | What it does to the change                                                |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Hardcoded values or identifiers         | Blocks decoupled supply of an input.                                      |
| Same knowledge in several places        | Turns one change into N edits that can drift.                             |
| Missing seam                            | No place to plug the new thing in without editing internals.              |
| Tangled responsibilities                | The new work must understand unrelated concerns.                          |
| Wrong or leaky abstraction              | New work bends around it or copies it.                                    |
| Misleading names or structure           | Readers, and the plan, go wrong.                                          |
| Implicit contracts                      | Rules that live only in people's heads or in a coincidence.               |
| Config sprawl or divergent environments | The change must be made and verified several ways.                        |
| No characterization tests               | Cannot refactor safely first.                                             |
| Dead or duplicate code in the way       | Noise to read and risk to preserve.                                       |
| Wrong home                              | The new thing has no natural location, so it lands somewhere it will rot. |

Reorganizing is legitimate: moving code or resources so the new work has a
natural home, deleting what is superseded, and simplifying before extending.

## Record each item

| Friction | Evidence (`file:line`) | Blocks | Fix cost | Verdict |
| -------- | ---------------------- | ------ | -------- | ------- |

**Blocks** names the input or the part of the change it makes harder. **Verdict**:

- **Fix first:** the change or an input is meaningfully easier afterwards.
- **Work around:** fixing costs more than it saves here; note the workaround.
- **Leave:** real but unrelated. Mention once in "Noticed, not doing" and move on.

## Gate

Every "fix first" names its blocked input or change and the later step that
benefits. Prune anything whose only justification is taste. List what you did not
look at and why, so gaps are visible.

Add the prior-art notes, conventions, and friction table to the roadmap document.
