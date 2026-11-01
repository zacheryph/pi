# Phase 1: True goal

The stated request is usually a solution. Find the outcome behind it, because
the cheapest roadmap often serves the outcome by a different route.

## No goal given

Do not invent one. Look for plans that already exist: one stated earlier in the
conversation, a `draft` roadmap in `docs/roadmaps/`, a `GRILL-ME.md`. Ask with
`ask`, offering each as a choice named after its plan, and let the user type
their own goal instead. If nothing exists, ask for the goal in one free-text
question. Log the answer as the first row of the Answers table.

## Look before asking

Read the README, docs, recent commits, issues, and the code the request touches.
Record what you learned as facts. Ask only about intent, priorities, and
constraints that no file can answer.

## What to establish

| Question                                                               | Why it matters                                                                      |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| What outcome do you want, and what happens if we do nothing?           | Separates the need from the proposed solution and sets urgency.                     |
| Who or what consumes the result, and how will they use it?             | Defines the inputs and the interface.                                               |
| How will we know it worked?                                            | Success criteria that steps can be checked against.                                 |
| What is explicitly out of scope?                                       | Stops preparation from growing into a rewrite.                                      |
| What must not break or change?                                         | Fixed constraints versus changeable ones.                                           |
| Which existing pieces may we change, and which belong to someone else? | The licence to refactor. Ownership boundaries are where contracts belong.           |
| What will likely be asked next?                                        | Tells which seams are worth building. Do not design for it, only avoid blocking it. |
| What is the appetite: smallest change, or leave the area better?       | Chooses between baseline and deeper options in phase 4.                             |
| Hard deadlines, rollout limits, environments, compliance?              | Constrains ordering and shippability.                                               |

Use "why" to climb one or two levels: "we need X" → "so that Y" → "because Z".
Stop when the answer is an outcome nobody would ask the reason for. Challenge
the request once if a different framing is clearly cheaper, then accept the
user's answer.

## Goal brief (gate)

Write this at the top of the roadmap document and get a yes or a correction:

```markdown
## Goal brief

**Stated request:** <what was asked>
**True goal:** <the outcome it serves>
**Consumers:** <who or what uses it>
**Success criteria:** <observable, checkable>
**Non-goals:** <explicitly not doing>
**Constraints:** <must not break, deadlines, compliance>
**Open to change:** <existing things we may modify> / **Off limits:** <and why>
**Appetite:** <baseline | leave it better | rework the area>
**Facts established from the repo:** <short list with file references>
```

If `GRILL-ME.md` exists, fold its decisions in and cite them.

## Answers

Log every question you asked or settled from the repo, in the order they came
up, directly under the goal brief. Keep adding rows in later phases; phase 4's
choice of option is recorded under `## Decision`, not here.

```markdown
## Answers

| #   | Question                      | Recommended                    | Answer                 | Source           | Status   |
| --- | ----------------------------- | ------------------------------ | ---------------------- | ---------------- | -------- |
| 1   | Keep the v1 endpoint?         | Yes: two clients still call it | No, retire it in March | user             | resolved |
| 2   | Where does the timeout live?  | —                              | `config/lb.yaml`       | `src/load.ts:14` | resolved |
| 3   | Which region rolls out first? | eu-west: lowest traffic        | —                      | —                | open     |
```

- **Recommended** is what you showed the user, so a reader can see where they
  overrode it. Use `—` for facts read from the repo.
- **Answer** is the user's choice in their words, including any text they typed.
- **Source** is `user`, a `file:line`, or `GRILL-ME.md`.
- **Status** is `resolved` only when the Answer column has the user's answer or
  a cited fact. Dismissed or unasked questions are `open` and also go under
  `## Open questions`.
