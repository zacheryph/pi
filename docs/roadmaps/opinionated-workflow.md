# Make the next step obvious

Status: proposed · Updated: 2026-11-25

## Goal brief

Help a person using this bundle turn an intention into one concrete next action, then know what is active, blocked, or ready for review when returning later. Make the existing tools feel like a coherent workflow without adding another task system.

**Success means:** a newcomer can find one recommended starting path in the docs; a user can move from a todo to delegated/background work and back to a clear completion/review state; existing tasks, jobs, and subagents remain the source of truth; each stage can still be used independently.

**Non-goals:** redesigning task/job/subagent internals; automating task selection or taking destructive actions; replacing `/todo` or `/dashboard`; supporting every Pi mode with identical UI; adding a new persistent workflow database.

**Constraints:** preserve existing command/tool APIs where possible; stay useful in interactive TUI and document alternate command-based path; favor incremental, independently shippable work. This roadmap may change documentation and UI composition, but should avoid changing lifecycle semantics without evidence from user testing.

## Inputs and contracts

| Input | Source today | Owner / recommended supply | Decoupling |
| --- | --- | --- | --- |
| User's intended outcome and priority | User prompt / todo task | User supplies a concise task and optional priority through existing `todo_upsert` / `/todo:add` | No new schema initially; avoid guessing priority. |
| Current task state, dependencies, review notes | pi-todo ledger (`README.md:467–495`) | pi-todo remains the owner; use its existing read/write tools and stable task keys | Do not duplicate task state in dashboard or a new work ledger. |
| Active background work and completion | pi-work, pi-job, pi-subagent | Producers keep owning lifecycle; the workflow view consumes existing work snapshots/events | Shared work abstraction already exists (`packages/pi-work/README.md:1–26`); compose, don't reimplement. |
| Choice to delegate or run a command | User/agent | Existing `subagent_start` handoff and job tools | Keep explicit; workflow may suggest, never silently dispatch. |
| Readiness for next action / review | Todo history and work completion messages | Derive presentation from current task/work state; ask user to mark/review where state is ambiguous | Do not infer task completion from a successful job alone. |
| TUI vs non-TUI context | Pi session mode | Existing `/todo`, `/dashboard`, tools, and job commands | Document the best available path per mode; don't promise dashboard in RPC/print. |

## What exists and friction

- The root README is detailed and documents local setup as recommended, plus Git install, `pi -e .`, and project-local install (`README.md:8–16, 48–72`). It also warns against duplicate todo/job/subagent extensions (`README.md:95–103`). Useful, but installation detail competes with the question “what do I do first?”
- Todo already supports stable keys, dependencies, review history, and delegated handoff (`README.md:467–495`). Its searchable `/todo` browser and commands are documented separately (`extensions/pi-todo/README.md:137–162`). Editing and reviewing are capable but not yet an explicit end-to-end starting recipe.
- Background jobs and subagents have start/watch/inspect controls and completion delivery. Their expected usage includes ending the turn rather than polling (`extensions/pi-job/README.md:10–40`; `extensions/pi-subagent/README.md:54–70`). A person can miss the intended “leave it and return on completion” loop if they encounter these as separate tools.
- `/dashboard` presents live session/work summaries, but is limited to interactive TUI sessions and excludes child sessions (`README.md:263–282`; `extensions/pi-dashboard/README.md:102–106`). It is useful for orientation, but cannot be the sole path.
- pi-work already provides shared work-item persistence, transcript messages, widgets and dashboard integration (`packages/pi-work/README.md:1–26`). This is the right base for coherent presentation; a parallel unified tracker would add needless state.

**Fix first:** no structural fix is justified yet. First make the workflow legible in docs and validate the desired sequence with real use. If users still have to mentally stitch together states, add a small view over existing sources. **Not verified:** this review did not run Pi or interview users, so whether a new combined UI is needed remains an assumption.

## Options considered

1. **Docs-only path (least preparation).** Add a short “start here / continue work” section with one canonical sequence and pointers for TUI vs non-TUI. Cheapest and low risk, but does not reduce in-product context switching.
2. **Guided workflow view (recommended).** Start by documenting and validating the sequence, then add a focused `/work` or `/next` overview only if existing `/todo` and `/dashboard` do not adequately answer “what should I pick up?” Compose task and work data from their owners; link into existing actions. Stronger orientation without replacing subsystems, but requires interaction-design/testing work and may duplicate dashboard content if not carefully scoped.
3. **Automatic orchestration.** Automatically choose a task and dispatch jobs/subagents. It could reduce clicks but makes assumptions about priority and risk, adds policy/state complexity, and is not supported by evidence that users want automation. Not recommended.

## Recommended roadmap: guided workflow view, with a docs-first gate

### 1. Write the canonical workflow guide

Document a short path: capture a task; pick one unblocked task; decide to do it, delegate it, or start a job; end the turn when waiting; return to the completion message; update/review the task. Include exact commands and a non-TUI alternative, and link detailed references instead of duplicating them.

**Done when:** a reader can follow it using only commands/tools already documented; `npm run verify:bundle` and relevant docs checks pass. **Ships alone:** yes. This directly improves discoverability without UI risk.

### 2. Validate against actual use before building UI

Use the guide for several real work sessions, including at least one delegated task and one longer-running job. Record where the user has to switch views, reconstruct state, or cannot tell the next action. Keep feedback concrete and separate observed problems from preferences.

**Done when:** there is a short set of observed friction points, or evidence that the docs are sufficient. If the docs solve the problem, stop here. This step prevents a speculative dashboard feature.

### 3. Define the minimum orientation surface (only if step 2 warrants it)

Specify the exact question it answers, likely “what can I pick up now, and what am I waiting on?” Reuse todo and pi-work read models; show unblocked tasks, active work, and completion/review prompts with links/actions to existing commands. Explicitly handle empty/narrow states and unavailable data. Do not write task state from the view or auto-dispatch.

**Done when:** a small design note maps every displayed state to an existing owner/source and explains TUI and non-TUI behavior. If this requires a second task store or changes lifecycle semantics, return to options rather than proceeding.

### 4. Implement and test a thin view

Build the view in the existing dashboard/work presentation layer (confirm ownership during implementation), with direct commands remaining available. Cover empty, blocked, active, completed-unreviewed, reload, narrow terminal, ANSI/wide Unicode, and unavailable-data cases. Follow repository UI spacing rules. Verify with relevant workspace tests and a TUI screenshot; if bb UI is changed, run `bb-shot.mjs --expand --check`.

**Done when:** one place reliably orients the user without creating duplicate state; rendering and workspace tests pass. This is the easy change after the docs and observations make its scope small.

### 5. Measure and simplify

After use, check whether people can resume work with fewer manual lookups and whether the view overlaps confusingly with `/todo` or `/dashboard`. Remove sections that do not help choose or resume work; keep the view only if it adds value.

**Done when:** documented usage feedback supports keeping it, or the feature is removed and the docs-only improvement remains.

## Open questions

- Is the primary use case the root interactive TUI, or should the workflow be equally smooth over RPC/print? Existing dashboard support is TUI-only, so this changes the design if parity is required.
- Which existing surface is most natural for orientation: `/todo`, `/dashboard`, or a small separate command? Gather usage evidence before choosing.
- What exactly counts as “ready for review” for a todo? Do not infer this from work completion unless user expectations confirm it.
- How many real sessions are enough to decide whether the guide alone is sufficient? Proposed: three, including delegation and a long-running job.
