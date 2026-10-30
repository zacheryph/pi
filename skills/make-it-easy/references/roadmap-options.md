# Phase 4: Roadmap options

Build two or three roadmaps that are different strategies. Reduce them to a
recommendation the user can accept, reject, or merge.

## Strategy archetypes

Pick the ones that genuinely fit. Invent others if the situation calls for it.

| Strategy | Shape | Fits when |
| --- | --- | --- |
| **Baseline** | Do the change directly with minimal preparation; accept the friction. | One-off work, nobody returns to this area, or time is tight. Always include it. |
| **Seam first** | Establish contracts for the inputs and retrofit producers, then build the feature against them. | Inputs are hardcoded or tangled, producers and consumers have different owners, or more consumers are coming. |
| **Reshape first** | Simplify, extract, move, or delete in the existing area, then add the feature into the cleaner shape. | Friction is structural: duplication, wrong home, tangled responsibilities. |
| **Parallel and migrate** | Build the new path beside the old one, move callers across gradually, then remove the old. | Replacing something live where a big-bang cutover is risky. |
| **Thin slice** | Deliver the narrowest end-to-end version first, then widen. | Requirements are uncertain and early feedback matters more than structure. |

Strategies combine. State the combination explicitly instead of hiding it.

## Option card

For each option:

```markdown
### Option <letter>: <strategy name>
**Idea:** <two sentences>
**Steps:** 1. <prep> → 2. <prep> → … → N. <the change> → N+1. <cleanup>
**What it makes easy:** <inputs supplied, friction removed>
**What it leaves behind:** <debt, workarounds, or lasting structure>
**Cost:** <relative: S/M/L, and where it concentrates>
**Risk and reversibility:** <what can go wrong, how to back out each step>
**Value timing:** <what ships, and when>
**Choose it when:** <conditions>
```

## Compare

Put the options side by side on the dimensions that differ: total effort, effort
before first value, risk, reversibility, lasting structure, how easy the
follow-up changes become, and blast radius on things owned by others.

## Recommend

Recommend one option and give the reason in terms of the goal brief: the
appetite, constraints, and the inputs' ownership. Say what would change your
mind. Do not recommend deeper preparation than the goal brief supports.

State plainly if the baseline is the right answer. Preparation that the goal
does not pay for is waste.

## Present

Ask the user to choose, merge, or reject. Offer the recommendation first. Update
the roadmap document with the options and the decision, then continue to
step detail.
