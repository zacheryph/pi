---
issue: 904
issue_title: "pi-subagents: the genericBase fallback tells a read-only child it can edit files and run commands"
---

# Stop the fallback identity asserting anything it cannot know

## Release Recommendation

**Release:** ship independently

Adopted as Phase 22 Step 20 by operator decision, and that step carries `Release: independent` — it is a member of no release batch.
The change is user-visible in a child's assembled system prompt, so the `fix:` commit cuts a release on its own.
The roadmap's `Release batches` subsection omits Step 20 from its "Independently releasable" enumeration; this plan corrects that omission as part of the doc step.

## Problem Statement

`genericBase` in `src/session/prompts.ts` is the fallback identity every agent type receives when no parent contribution is usable.
Its third line asserts a capability set — "You have full access to read, write, edit files, and execute commands" — that a read-only agent does not hold.

Measured, by calling `buildAgentPrompt` with an `Explore` config and a `portable` strategy with no capture, an `Explore` child receives this:

```text
# Role
You are a general-purpose coding agent for complex, multi-step tasks.
You have full access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.

<active_agent name="Explore"/>

# Environment
Working directory: /w
…

# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a file search specialist. …
Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools.
```

The prompt contradicts itself twelve lines in, before any extension appends anything.
This is the claim [ADR-0008] removed the `<sub_agent_context>` block over ([#890]); the constant four lines below it survived that sweep because it sits on a different path.

The operator's gate widened the diagnosis past the capability sentence.
The constant is reached for **every** agent type, including a user's custom `.md` agent, so each remaining clause of its role sentence is an equally unverified claim:

| Clause                              | Why the fallback cannot know it                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| "coding"                            | Nothing in `buildAgentPrompt` knows the child's domain; a custom agent may review prose or draft issues |
| "general-purpose"                   | Names one of the three built-in agent types (`src/config/default-agents.ts`)                            |
| "for complex, multi-step tasks"     | Lifted verbatim from that same type's `description`; an `Explore` task is often neither                 |
| "full access to read, write, edit…" | The defect the issue reports                                                                            |

## Goals

- Reduce `genericBase` to the one sentence that is true of every child regardless of type, tool set, or domain.
- Pin the outcome with a test that a read-only agent reaching the fallback receives an identity region asserting no capability.
- Record the resolution against [ADR-0009]'s accepted residual and the roadmap's Step 20.

Not breaking.
The change alters the text of a child's system prompt on a fallback path; it changes no public type, no config key, no default value, and no exported signature.
[#890] made the same class of change to the same file under a plain `fix:` commit, and this follows it.

## Non-Goals

- **Rendering the child's actual tool surface into the fallback.**
  That is [ADR-0014]'s scope in `@gotgenes/pi-permission-system`, which appends a per-session block at the prompt tail.
  Putting node-local prose back into the one identity that exists to stay harness-neutral would reintroduce the defect from the other side.
- **Giving a child without `@gotgenes/pi-permission-system` any tool-surface prose at all.**
  Verified in the pinned `@earendil-works/pi-coding-agent@0.84.4` (`dist/core/system-prompt.js`): under `customPrompt` Pi writes no `Available tools:` list and no `Guidelines:` block, and `systemPromptOverride` replaces the assembled prompt outright.
  That gap is [#901], already open.
- **Renaming `genericBase`.**
  The name still describes what it is — the generic fallback base — and renaming it ripples into [ADR-0009], [ADR-0010], the roadmap, and `.pi/skills/package-pi-subagents/SKILL.md` for no behavior gain.
- **Changing the `full` inheritance path.**
  `genericBase` is never reached under `full` with a real parent prompt; an empty parent prompt yields an empty identity, not the fallback (see Background).
- **Making the fallback agent-aware.**
  Considered at the gate and declined: it would require widening `AgentPromptConfig` (today `name`, `promptMode`, `systemPrompt` only) to carry `description`, an ISP regression on a deliberately narrow type.

## Background

`buildAgentPrompt(config, cwd, env, inherited?, loadProjectContext?)` in `src/session/prompts.ts` composes a child prompt as `identity + projectContext + "\n\n" + header + …`.
`identity` is `inherited ? adoptedIdentity(inherited, cwd) : genericBase` (line 70).

Two arms reach the constant, and they are not equally live.

1. **`inherited === undefined` (line 70).**
   Dead in production: `assembleSessionConfig` in `src/session/session-config.ts:189` always constructs and passes an `InheritedPrompt`.
   Only tests and a hypothetical direct caller reach it.
   The issue's own reachability question ("it should be rare in an interactive session") was asked about this arm.
2. **`adoptedIdentity`'s portable fallback (line 140).**
   Live, and for its population it is the **default**: a child whose provider is mapped to `portable` in `promptInheritance` falls back whenever `portablePrompt` is absent or whitespace-only, which is every parent that runs without `--system-prompt` and `--append-system-prompt`.
   [ADR-0009] records this as an accepted residual and names [#904] as its tracker.

An empty-string parent prompt under `full` does **not** reach the constant: `adoptedIdentity` routes to `inheritedIdentity("")`, which finds no anchor and returns the empty string.
That edge was established deliberately in [#640] and is unchanged here.

Constraint from `AGENTS.md`: a change to a shared mutable artifact several parties write needs its other writers enumerated.
The writers of a child's system prompt are Pi's `buildSystemPrompt`, this package's `buildAgentPrompt`, `@gotgenes/pi-permission-system`'s `renderToolSurface`, and `@gotgenes/pi-anthropic-auth`'s OAuth shaping.
The last one keys off `PI_DEFAULT_PROMPT_PREFIX` ("You are an expert coding assistant operating inside pi…") and the three `PARAGRAPH_REMOVAL_ANCHORS` in its `src/constants.ts`.
`genericBase` matches none of them today, and matches none under the new text either, so no shaping behavior changes.

## Design Overview

`genericBase` becomes exactly two lines:

```text
# Instructions
Do what has been asked; nothing more, nothing less.
```

The surviving sentence is the only one in the constant that was never a claim about capability, domain, purpose, or type.
Everything the removed lines gestured at is supplied more accurately downstream: the `<active_agent name="…"/>` tag names the agent, the agent's own `systemPrompt` states its role (in `replace` mode with full control), and the tool array in the API request — plus `renderToolSurface` when `@gotgenes/pi-permission-system` is installed — states its tools.

The `# Role` heading becomes `# Instructions` because the section no longer states a role.
That heading is load-bearing only in tests: three assertions use `prompt.startsWith("# Role")` as a "this is the fallback, not Pi's base" marker, and each already carries the stronger discriminator `not.toContain("pi packages (docs/packages.md)")` beside it.

Measured size change: 199 characters over 4 lines → 66 characters over 2 lines.

No signature changes, no new collaborator, no control-flow change.
`buildAgentPrompt`, `adoptedIdentity`, `inheritedIdentity`, and the anchor-search helpers are untouched; the Tidy-First assessor confirmed none of that machinery reads the constant's content.

### What the new test asserts

The outcome is the **absence** of a capability claim, so the assertion is scoped to the identity region rather than the whole prompt:

```typescript
const prompt = buildAgentPrompt(exploreConfig, "/workspace", env, {
  systemPrompt: PI_BASE,
  cwd: PARENT_CWD,
  strategy: "portable",
});
const identity = prompt.slice(0, prompt.indexOf("<active_agent"));
expect(identity).not.toMatch(/\bwrite\b/i);
expect(identity).not.toMatch(/\bedit\b/i);
expect(identity).not.toMatch(/execute commands/i);
```

Whole-prompt scoping would be wrong, and demonstrably so: `Explore`'s own `systemPrompt` contains "Using redirect operators (>, >>, |) or heredocs to write to files", so `/\bwrite\b/` over the full prompt fails regardless of the fix.
The test drives the **portable** arm rather than the `inherited === undefined` arm, because that is the arm production reaches.

## Module-Level Changes

| File                                                                                   | Change                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/pi-subagents/src/session/prompts.ts`                                         | Rewrite the `genericBase` template literal (lines 310–314) to the two-line text; reword its doc comment, which today reads "Fallback base prompt when parent system prompt is unavailable (both modes)" and should say what the constant now deliberately omits                                                                                |
| `packages/pi-subagents/test/session/prompts.test.ts`                                   | Add a `GENERIC_BASE` constant and repoint seven assertions at it (lines 85, 124, 202, 261, 1090, 1101, 1119); update its value in the fix step; add the read-only fallback test                                                                                                                                                                |
| `packages/pi-subagents/docs/decisions/0009-portable-inheritance-is-provider-scoped.md` | Add a dated `Amended 2026-09-18 ([#904])` line to the `## Status` section and rewrite the "Accepted residual" bullet in `## Consequences` to record the resolution                                                                                                                                                                             |
| `packages/pi-subagents/docs/architecture/architecture.md`                              | Mark `#### Step 20` as `✅`, add its `Landed:` note, add an `S20` node to the `Step dependencies` Mermaid (`S18 -.informs.-> S20`, since Step 18 shipped the reasoning this applies), extend the `Track H` bullet to name Step 20, and add Step 20 to both the "Independently releasable" list and its `fix:` enumeration in `Release batches` |

Predicted unchanged, with the claim each rests on:

| File                                                                                 | Prediction rests on                                                                                                                            |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/pi-subagents/docs/decisions/0010-project-context-is-directory-resolved.md` | Its one `genericBase` mention (line 96) names the constant, quotes no wording, and states a consequence about project context that stays true  |
| `.pi/skills/package-pi-subagents/SKILL.md`                                           | Its one mention — "An absent or whitespace-only capture falls back to `genericBase`, never to the full prompt" — is about routing, not wording |
| `packages/pi-subagents/README.md`, `packages/pi-subagents/docs/configuration.md`     | Neither contains `genericBase`, `# Role`, or the capability sentence (grepped)                                                                 |
| `packages/pi-permission-system/**`                                                   | `renderToolSurface` anchors on `Current working directory: `, not on any identity text                                                         |

Greps run to build this list: `genericBase`, `general-purpose coding agent`, `# Role`, and `full access to read, write, edit` across `packages/`, `.pi/`, and `docs/`.
The only other hits are in `docs/plans/` and `docs/retro/` files, which are historical records of prior sessions and are not updated.
The roadmap's issue-disposition bullet at `architecture.md:857` quotes the sentence as the reason Step 20 exists; it is a historical disposition and stays.

## Test Impact Analysis

The existing suite (66 tests in `test/session/prompts.test.ts`, all green — measured) already covers both fallback arms.
What it does not cover is the claim the fix makes: that the fallback names no capability.

1. **Enabled by the change:** a read-only-agent fallback test scoped to the identity region.
   It was not previously possible to write meaningfully, because the assertion it needs is about the region rather than the prompt, and no test sliced the prompt that way.
2. **Redundant afterwards:** none.
   The four `toContain` and three `startsWith` assertions each pin a distinct path (append/replace × parent/no-parent, plus the three portable fail-safe cases) and all stay.
3. **Must stay as-is:** the `shared prefix with the parent` block at line 831 and the portable `not.toContain("pi packages (docs/packages.md)")` assertions.
   Both exercise layers this change does not touch, and the second is the real fail-safe discriminator.

## Invariants at risk

| Invariant                                                                 | Source                         | Pinned by                                                                      | Holds?                                                                                                                            |
| ------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| The inherited region stays a byte-identical shared prefix with the parent | [ADR-0008], Step 18 `Outcome:` | `test/session/prompts.test.ts:831` `describe("shared prefix with the parent")` | Yes — that region is `inheritedIdentity`'s output on the `full` path; `genericBase` is never on it                                |
| An unusable portable capture never re-embeds the harness base             | [ADR-0009]                     | `test/session/prompts.test.ts:1085–1105`                                       | Yes — the discriminator is `not.toContain("pi packages (docs/packages.md)")`, untouched; only the positional marker changes value |
| A portable child still resolves its own project context                   | [ADR-0010]                     | `test/session/prompts.test.ts:1105–1125`                                       | Yes — `ownProjectContext` is untouched                                                                                            |

Constituencies, named:

- **[#180]'s local-inference users** are served by the `full` path's shared prefix.
  `genericBase` is not on that path, so the prefix is unaffected and the measured 133-character reduction costs them nothing.
- **[#883]'s re-homing-host users** (the portable population) are the ones whose default identity changes.
  For them the change is strictly a removal of false claims; the fail-safe property [ADR-0009] exists to protect is the `not.toContain` assertion above, which is untouched.
- **A child of any read-only agent** is the constituency the issue reports for, and the new test is written for it.

Quantitative check: the fallback identity is not a cache prefix any consumer depends on byte-for-byte — [ADR-0008]'s guarantee is scoped to the inherited region, and a portable child by construction shares no prefix with its parent.
So the 199 → 66 character change has no cache consequence to predict.

## TDD Order

1. **`test(pi-subagents): pin the fallback base text in one shared constant`** — preparatory (Tidy First).
   Surface: `test/session/prompts.test.ts`.
   Introduce one module-level constant holding the **current** four-line `genericBase` text verbatim, and repoint all seven assertions at it — `toContain(GENERIC_BASE)` at lines 85, 124, 202, 261 and `startsWith(GENERIC_BASE)` at 1090, 1101, 1119.
   The friction this prepares: seven assertions in five independent blocks each hardcode a different fragment of the wording the next step replaces, so without this the fix step improvises new wording seven times.
   The tree stays green — each assertion becomes strictly stronger (a full-text match instead of a fragment), and `identity` is `genericBase` verbatim on every one of those paths.
   Killing mutation: change one character inside `GENERIC_BASE` (e.g. `# Roles`) — all seven assertions must turn red; a green run would mean the constant is not pinning the real one.
2. **`fix(pi-subagents): stop the fallback prompt claiming tools the child may not hold`** — the behavior change.
   Red: add the read-only fallback test from Design Overview (`Explore`, `strategy: "portable"`, no capture; identity region matches no capability token).
   It fails today on `/\bwrite\b/` and `/\bedit\b/`.
   Green: rewrite `genericBase` in `src/session/prompts.ts` to the two-line text, reword its doc comment, and update `GENERIC_BASE`'s value in the test file — one line, by construction of step 1.
   Verify: `pnpm --filter @gotgenes/pi-subagents run check` and the full package suite.
   Killing mutations, one per equivalence class:
   - Re-add the line `You have full access to read, write, edit files, and execute commands.` to `genericBase` → the new test's three assertions turn red, and so do all seven step-1 assertions.
   - Re-add only the role sentence (`You are a general-purpose coding agent for complex, multi-step tasks.`) → the new test stays **green** (it names no capability) while the seven step-1 assertions turn red.
     That split is the point: the new test pins the capability claim, the constant pins the exact text, and neither alone covers both.
   - Widen the new test's slice to the whole prompt (delete the `indexOf("<active_agent")` bound) → `/\bwrite\b/` turns red against `Explore`'s own "heredocs to write to files", confirming the region scoping is load-bearing rather than decorative.
3. **`docs(pi-subagents): record the resolved portable-fallback residual`**.
   Surface: [ADR-0009] and the architecture roadmap.
   Add the dated `Amended … ([#904])` line to [ADR-0009]'s `## Status` and rewrite its "Accepted residual" bullet to state the resolution — the decision itself is unchanged, only the consequence that had been accepted.
   Mark Step 20 `✅` with a `Landed:` note recording the two findings this plan established: that the `inherited === undefined` arm is dead in production and the portable arm is the live one, and that the fix went past the capability sentence to the whole role claim.
   Add the `S20` node and the `S18 -.informs.-> S20` edge to the Step-dependencies Mermaid, extend `Track H` to name it, and add Step 20 to the `Release batches` "Independently releasable" enumeration it is currently missing from.
   Verify: `pnpm exec rumdl check` on each edited file, and read the Mermaid block end to end after editing.

## Risks and Mitigations

| Risk                                                                                                  | Mitigation                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A child on the fallback path now receives no prose about its tools at all**                         | It already receives none from Pi — verified in the pinned 0.84.4 bundle, where the `customPrompt` branch writes no `Available tools:` and no `Guidelines:`. The removed sentence was not describing the child's tools; it was asserting a fixed set. The tool array in the request is what the model actually reads, and `renderToolSurface` supplies prose when installed. The residual gap is [#901] |
| **A `general-purpose` child in append mode with an empty `systemPrompt` is left with almost no text** | Bounded and deliberate: such a child gets `# Instructions` + the instruction sentence + its `<active_agent>` tag + env block + its own project context. The alternative considered at the gate — removing `genericBase` entirely — would have left it with no instructions at all, and was declined for exactly this case                                                                              |
| **The three `startsWith` assertions stop discriminating the fallback from Pi's base**                 | They never were the discriminator; the `not.toContain("pi packages (docs/packages.md)")` assertion beside each one is, and it is untouched. Step 1 makes the positional assertion stronger by pinning the full text rather than a six-character heading                                                                                                                                                |
| **Step 1's "the tree stays green" claim is wrong for one of the seven sites**                         | It is a prediction the step's own green run falsifies immediately, at zero cost, before any `src/` change exists. The claim rests on `identity` being `genericBase` verbatim on all seven paths, which the file's structure shows: four sites pass no `inherited` at all, and three pass `portable` with no usable capture                                                                             |
| **`@gotgenes/pi-anthropic-auth` shaping changes for a portable child**                                | Its anchors are `PI_DEFAULT_PROMPT_PREFIX` and three `PARAGRAPH_REMOVAL_ANCHORS`, read from its `src/constants.ts`. Neither the old nor the new text matches any of them, so the shaping no-ops before and after                                                                                                                                                                                       |

## Open Questions

- **Should `genericBase` be renamed now that it asserts no identity?**
  Deferred with no issue filed.
  The name describes the constant's role (the generic fallback base), the rename has no behavior consequence, and it would touch two ADRs, the roadmap, and a skill file.
- **Should a child without `@gotgenes/pi-permission-system` get tool-surface prose from this package?**
  Out of scope, and already tracked as [#901], whose roadmap disposition defers it for needing this package's first per-turn `before_agent_start` handler.

[#180]: https://github.com/gotgenes/pi-packages/issues/180
[#640]: https://github.com/gotgenes/pi-packages/issues/640
[#883]: https://github.com/gotgenes/pi-packages/issues/883
[#890]: https://github.com/gotgenes/pi-packages/issues/890
[#901]: https://github.com/gotgenes/pi-packages/issues/901
[ADR-0008]: https://github.com/gotgenes/pi-packages/blob/main/packages/pi-subagents/docs/decisions/0008-inherited-region-is-shared-parts.md
[ADR-0009]: https://github.com/gotgenes/pi-packages/blob/main/packages/pi-subagents/docs/decisions/0009-portable-inheritance-is-provider-scoped.md
[ADR-0010]: https://github.com/gotgenes/pi-packages/blob/main/packages/pi-subagents/docs/decisions/0010-project-context-is-directory-resolved.md
[ADR-0014]: https://github.com/gotgenes/pi-packages/blob/main/packages/pi-permission-system/docs/decisions/0014-tool-surface-is-node-local-prose.md
