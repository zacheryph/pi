# Roadmaps as data: options for zacheryph/pi

Recommendation: keep `make-it-easy` and `execute-roadmap` as skills, backed by a small JSON model and a deterministic command-line generator. Start with scripts shipped beside the skills. An extension becomes useful when you want automatic lifecycle enforcement, session events, or native Pi UI; generating documents does not require one.

This is a design exploration and working rendering prototype, not a repository change. Inspected main at `f1868380a87dced2a6359e31b6f7060e2baf3381` on November 16, 2026. The sample is fictional.

## What the current skills already have

[`make-it-easy`](https://github.com/zacheryph/pi/blob/f1868380a87dced2a6359e31b6f7060e2baf3381/skills/make-it-easy/SKILL.md) writes one Markdown document containing the goal, answers, inputs, friction, alternatives, decision, ordered steps, and open questions. Its [step template](https://github.com/zacheryph/pi/blob/f1868380a87dced2a6359e31b6f7060e2baf3381/skills/make-it-easy/references/roadmap-template.md) already specifies dependencies, acceptance criteria, verification, rollback, size, shippability and which later work a preparatory step makes easier.

[`execute-roadmap`](https://github.com/zacheryph/pi/blob/f1868380a87dced2a6359e31b6f7060e2baf3381/skills/execute-roadmap/SKILL.md) treats the document as the authority, copies its steps into session todos, records detailed stages as task messages, and writes landed evidence back to Markdown. For PR delivery, completion requires merge and deployment verification where available. Those semantics should survive the change.

[`pi-todo`](https://github.com/zacheryph/pi/blob/f1868380a87dced2a6359e31b6f7060e2baf3381/extensions/pi-todo/README.md) is a bounded session work ledger: 50 unfinished tasks, a limited completed archive, and dependency links removed when prerequisites are archived. It is useful for execution, but does not preserve the full historical roadmap graph. The repository's [package.json](https://github.com/zacheryph/pi/blob/f1868380a87dced2a6359e31b6f7060e2baf3381/package.json) already declares AJV; schema validation need not introduce a new validator choice.

## Three ways to package it

| Approach | Where the behavior lives | What you gain | Cost / limit |
| --- | --- | --- | --- |
| **A. Skills + bundled scripts — recommended first** | Shared schema, validator, patch commands and templates shipped alongside the skills | JSON, Markdown and HTML; usable from ordinary shell tools; no session runtime | Skills must remember to call the commands. No automatic event capture or enforcement outside the CLI. |
| **B. Standalone roadmap package / CLI** | A small package exposing model operations and rendering, with skills as callers | Same data model reusable from Pi, CI, editors and other repositories; independently testable API | Package exports, installation and versioning. Worth it once a second consumer actually needs them. Still no extension required. |
| **C. Thin Pi extension over B** | Package remains the engine; extension exposes tools, session hooks and views | Native status updates, narrow structured mutation tools, event-driven reconciliation, optional surface view | More integration and runtime lifecycle to maintain. Choose it for automatic behavior, not to obtain HTML. |

I would start with A and extract B if reuse earns it. The skill plans and reasons; code validates state changes, computes readiness and renders. Avoid having the model rewrite an entire Markdown document or HTML page at every milestone.

## Two useful storage shapes

| Shape | Example files | Best fit |
| --- | --- | --- |
| **One JSON per roadmap** | `docs/roadmaps/tool-library.roadmap.json`, generated `tool-library.md` and `tool-library.html` | Simplest start; single writer; plan and durable progress reviewed together. This is what the prototype demonstrates. |
| **Definition + execution record** | `tool-library.plan.json`, `tool-library.progress.json`; ignored local run file for agent IDs, worktrees and watch IDs | Concurrent work, frequent progress updates, stable plan reviews. Both files share a roadmap ID; progress names the plan revision. More reconciliation rules. |

Begin with one JSON but keep `execution` separate inside each step, so splitting later is a mechanical storage change. Do not save machine-specific paths, agent IDs, credentials or watch handles in the committed roadmap. A local run file can hold them. Keep verification and landed evidence durable, including dates and the revision/head it checked.

An append-only event log plus snapshot is a possible later design for many writers. It is not my starting recommendation: event ordering, replay, rebases and conflict handling add more machinery than this workflow presently needs.

## What belongs in the model

| Record | Main contents |
| --- | --- |
| Roadmap | Stable ID, schema version, revision, title, lifecycle, goal brief, constraints and non-goals |
| Discovery | Questions and answers, source citations, input ownership and contracts, friction and prior art |
| Alternatives | Different strategies, costs, risks, value timing, recommendation; an explicit decision with source and date |
| Steps | Stable IDs, display order, type, track, scope, acceptance criteria, verification, rollback, shippability |
| Relationships | Hard prerequisites in `dependsOn`; preparatory beneficiaries in `eases` |
| Execution | Stage, delivery method, evidence, latest note; production should attach timestamps and checked commit/head identities |
| Open questions | Explicit affected step IDs; unresolved questions remain unresolved rather than silently becoming assumptions |

Allow prose **inside** JSON strings or string arrays. Structured data does not mean reducing a useful roadmap to task titles. The prototype carries the entire planning record into both Markdown and the HTML's “Full roadmap” view.

Use stable IDs such as `catalog-contract`, never step numbers as identity. Inserting or moving a step must not rename tasks, break dependency edges or lose PR associations. Display numbers are a rendering choice.

`dependsOn`, `eases`, track, display order and eventual delivery grouping mean different things. Only `dependsOn` controls readiness. “Ships together” should become an explicit delivery group if needed; it should not be encoded as a fake prerequisite. PR splitting and delivery groups are not implemented in this prototype.

## Saved versus calculated state

Save stages such as `pending`, `implementing`, `review`, `checks`, `awaiting_merge`, `verifying` and `done`. Compute **ready** from pending + completed prerequisites + resolved blocking questions. Compute **waiting** from unmet prerequisites. Compute upstream/downstream paths, parallel candidates and step-count progress. Do not store a second `ready: true` or a hand-edited percentage.

Waiting for a reviewer is different from waiting on a prerequisite. “Done” must keep its existing delivery meaning: worker finished, review passed, checks passed, merged and deployed are different points. Do not unlock a dependent merely because a PR exists or its checks are green.

No extension means the model cannot be forced to follow these rules through prose alone. A narrow CLI can reject invalid writes; a future extension can enforce writes made through its tools. Both need an explicit strategy for detecting edits made outside that interface.

## Data flow and authority

1. `make-it-easy` creates or patches the JSON incrementally as discovery proceeds. Drafts can be incomplete; publication and execution use stricter validation. The sample uses a fully populated shape; production needs separate draft and chosen constraints.
2. A validator checks shape and semantics: duplicate IDs, unknown references, cycles, questions that block work, accepted decision, and evidence required for completion.
3. A renderer generates Markdown with Mermaid and a self-contained HTML snapshot. Generated output includes source revision. No round-trip Markdown parsing.
4. `execute-roadmap` reads JSON and projects a bounded execution slice into `pi-todo`. Full roadmap history stays in JSON; the todo limit need not limit total roadmap length.
5. Execution results update the canonical record using stable step IDs, then refresh the todo projection and generated views. One coordinator owns durable writes. Workers report outcomes rather than writing the plan concurrently.
6. If a todo command changes a projected task, reconcile it explicitly. A user message is evidence of intent; a task marked completed is not proof of verification or merge. Surface disagreement instead of letting two stores silently overwrite each other.

Local run data may temporarily be newer than committed state. Views should disclose the snapshot revision and observation times. A static HTML export is not a live GitHub monitor. Branch-specific snapshots should state their branch/commit so readers know whose progress they are viewing.

## The two visual templates

**01 · Dependency map:** A top-down DAG with stage labels. Selecting a step highlights its ancestors and descendants. The adjacent inspector shows prerequisites, direct unlocks, acceptance criteria, verification, rollback and evidence. Best for scope changes, ordering and explaining bottlenecks. On small screens the inspector follows the graph. The prototype uses a small layered layout; production graphs with many nodes should use an established DAG layout engine and offer collapsing/filtering. No fake time axis or critical path: those require estimates that this example does not have.

**02 · Delivery board:** Completed / active / review and merge / ready / waiting columns. Each item has a real stage label and dependency or activity note. Selecting it opens the same inspector. Best for “what is going on right now?”; the map remains available when relationships matter. Columns reflow on narrow screens.

Both use the same twelve-step fictional community tool library. Four steps have illustrative completion evidence, checkout is being implemented, browsing is in review, and three independent steps are ready. The pilot joins browsing, checkout and an accessibility audit; launch joins the pilot, reminders and the lending guide. This is deliberately non-linear. Counts describe steps, not effort.

## Commands I would add in the real implementation

The prototype implements only `validate` and `render`. A production command set should also support narrow patches such as “set stage”, “record evidence”, “add dependency” and “record decision”, using an expected revision. Validate the candidate state before an atomic write. File locks or a serialized writer are needed for local concurrency; an atomic rename alone does not prevent lost updates.

Generation should be deterministic, with no current timestamp injected on every render. CI can validate the JSON and fail if checked-in Markdown is stale. I would commit Markdown for GitHub readability and publish HTML as an artifact or generated page; committing HTML is optional and adds diff noise. Read-only HTML can include JSON/Markdown export without acquiring filesystem-write authority. A browser editor would need an explicit download/import or local service workflow.

Use schema versions and explicit migrations; reject unknown fields so typos do not quietly vanish. Escape data in HTML and avoid arbitrary raw HTML or script execution. Sanitizing any future Markdown-to-HTML rendering is separate from graph layout.

## Migration and next decision

1. Add schema, validation and deterministic render commands beside the skills, with one representative fixture.
2. Import one existing roadmap into JSON and compare every existing planning section, dependency and landed record. Keep unresolved information open. Do not “parse and hope” across arbitrary prose formats.
3. Update `make-it-easy` to author JSON and regenerate its Markdown output.
4. Update `execute-roadmap` to read stable IDs, persist evidence in JSON, and maintain todos as an execution projection. Preserve review, merge and deploy gates. Revisit its requirement to land unrelated local steps in global display order: hard dependencies and review/delivery constraints should define necessary ordering.
5. Add split progress files, package extraction or a thin extension only when the real workflow needs them.

The main choice is A versus B, followed by whether durable progress should start in the same file or a separate file. My pick is **A, one JSON, two generated views**, while retaining a clean separation between planning data, durable execution evidence and local session handles.

## What the prototype proves and leaves open

Included: complete fictional JSON, JSON Schema, a dependency validator, readiness calculation, deterministic Markdown with Mermaid, and a self-contained HTML file with both visual templates and downloads. The generator uses Node built-ins and a small schema evaluator for the keywords used here; production should use the repository's AJV setup.

Not included: repository changes, automatic Pi events, mutation commands, locks/revision leases, todo synchronization, GitHub reconciliation, rich Markdown rendering, a full graph layout engine, multiple alternative DAGs or multi-PR delivery gates. Current options carry strategy records and the chosen option carries the executable graph; modeling a graph per alternative is a separate expansion if side-by-side option graphs are wanted.

Generation and semantic checks were exercised, including cycles, unknown dependencies, completion evidence and derived readiness. The generated JavaScript was syntax-checked. Browser visual verification was unavailable in this environment, so browser interactions and exact responsive rendering remain unverified.
