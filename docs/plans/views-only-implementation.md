# Shared session views: implementation plan

Status: implemented. PRs 1–8 are merged; [As implemented](#as-implemented)
maps the plan onto the code. The sections below are the plan as it was
followed, kept for its reasoning.

Design: [Views-only sessions](views-only-snapshot.md). This plan implements
package 8 of [RPC surfaces](rpc-surfaces.md).

Baseline checked: main `802542b1d6d6e98c0a0d3978bdfa41a8787a0f61`;
design PR #186 at `95ad84c84f093cbbc63188a0f31f495652868c50`.
No runtime implementation is included in the planning PR.

## Settled direction

- Extensions own their state. System-insights owns Pi core observation.
- Surface defines portable models, collects views and routes actions. It has
  no runtime dependency on Pi, a renderer or an extension.
- Dashboard and bb both migrate. Dashboard remains supported, including Focus.
- One complete delivery snapshot replaces the previous one at each receiver.
  No incremental merge, second section registry or snapshot-as-a-view recursion.
- A delivery snapshot contains only the identity needed to route the session,
  optional host capabilities and the collected views. The system view contains
  the core session information; adapters do not duplicate that information.
- Delete presentation after both consumers migrate. Do not create pi-snapshot
  or move extension-specific projections into dashboard.
- Existing prompt/tool/skill inspectors stay on demand. Ordinary chat/tool
  output, specialized terminal interfaces, new destructive item actions and
  the separate timeline-renderer project are outside this migration.

## Order and merge boundaries

Each row is one implementation PR. Merge #186 first, then use the latest main
for each PR. If branches are stacked for review, rebase after their dependencies
merge. Each merged PR must leave the existing bundle usable.

| PR  | Update                                                  | Depends on                      | Completion condition                                                           |
| --- | ------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------ |
| 1   | Shared session, summary and form contracts              | #186                            | Models validate and round-trip; existing renderers still work                  |
| 2   | Surface collection, lifecycle and consumer capabilities | 1                               | Complete bounded snapshots, safe removal and form-capability discovery work    |
| 3   | Core session view from system-insights                  | 1, 2                            | Core data is available without dashboard or bb                                 |
| 4   | Extension summaries, profile and runtime metadata       | 1, 2                            | Counts/profile data survive hidden widgets; saved-state semantics are explicit |
| 5   | Owned questionnaires and surface form publication       | 1, 2                            | Terminal/native-dialog routes still work; capable consumers can answer forms   |
| 6   | Dashboard migration, reporter and hub together          | 2, 3, 4, 5                      | Dashboard uses only views/actions and retains Focus                            |
| 7   | bb migration, Pi connection and plugin together         | 2, 3, 4, 5; recommended after 6 | Every bb slot and saved snapshot uses views/actions                            |
| 8   | Remove presentation and enforce dependency direction    | 6, 7                            | No old sections, aliases or package-to-extension imports remain                |

PRs 3, 4 and 5 are independent once 1 and 2 land. Dashboard and bb have the
same producer dependencies; dashboard first is the recommended review order,
not a runtime dependency. The final deletion waits for both consumers.

## 1. Shared contracts

Primary area: `packages/pi-surface/src/model.ts`, `views.ts`, `index.ts`, and
new focused model modules if needed. Update type re-exports in pi-ui and
presentation so extending the kind union does not break existing consumers.

Define portable JSON models and runtime validation for:

- `session`: core identity/name/directory, model/thinking/context, status and
  timestamps, activity and whole-session usage. Provider: `system.session`.
- `summary`: always-available structured counts, active-item identity and
  optional producer-owned identity/profile information. Counts have stable
  keys, labels, numeric values and optional process-bound semantics. These are
  independent of whether a widget is shown or how its rows are truncated.
- `form`: a bounded collection of independently identified questionnaires,
  each with its own questions/options, submit reference and cancellation.
  Provider: `ask.questions`. Questionnaire IDs remain opaque payload values,
  rather than being embedded into the restricted view-name syntax.
- Delivery snapshot and action request/result types, independent of an adapter
  or an extension. Keep connection identity separate from observed core data.
- Explicit process-bound status/clock metadata for runtime rows and counts.
  Persisted task states are not process-bound just because an icon is active.

Keep display text and machine-readable values separate. A summary reports
producer totals, never counts inferred from displayed or truncated rows.
The session model excludes main-agent profile data owned by pi-subagent.
Unknown future model kinds must not crash an older renderer.

Completion checks: JSON round-trip, malformed nested data and finite numbers,
concurrent questionnaire identity, existing widget/explorer/detail behavior,
and the no-Pi-runtime-import check. This PR defines models; it does not turn
on new remote interaction routes or change a wire protocol.

## 2. Surface collection and lifecycle

Primary area: `packages/pi-surface/src/views.ts` plus focused collection,
delivery and lifecycle modules. Adapters remain responsible for connections.

- Collect the current registered providers without a cached copy of extension
  state. Omit hidden/absent models; emit bounded error entries for failed ones.
- Preserve the 256 KiB per-view UTF-8 limit. Give collection a complete-message
  budget supplied by the adapter, reserving space for transport framing.
  Replace an oversized model with an error entry; reject an envelope if even
  its minimum metadata/error entries cannot fit. Never send malformed JSON,
  silently truncate forms or skip an update without reporting the failure.
- Preserve current transport ceilings: bb accepts 2 MiB messages; dashboard
  has a 1 MiB line ceiling. Validate actual encoded UTF-8 bytes at both sides,
  including a single oversized complete line and multibyte text.
- Announce view registration, change and removal after the registry change is
  visible. Existing removal currently does not announce; fix that so a removed
  view disappears without waiting for an unrelated event.
- Initial connection always reads the complete registry after consumer setup.
  Batch bursts of announcements at the adapter boundary; keep reads pure.
- Add session-scoped discovery of active form consumers. Consumers advertise
  only after their current connection and form handler are ready, revoke on
  disconnect/disposal, and do not advertise from saved snapshots or fixtures.
  This is capability discovery, not another state registry.
- Put saved-state normalization in the shared model layer. Strip forms,
  stop explicit process-bound activity/clocks/counts, preserve finished history
  and ordinary task statuses, and disable actions while no session is live.
  Normalize a copy so restoring a snapshot cannot mutate a live producer.

Tests must cover first publication, dynamic removal, session replacement,
reload/disposal, provider isolation, missing system view, byte limits, multiple
consumers, capability withdrawal and saved-state normalization. Freeze a
reproduction fixture for the stale-running bb card, even if a live reproduction
is not available; a screenshot reproduction is desirable, not a blocker.

No transport switches to the new delivery shape in this PR. The new collector
can be tested independently while old consumers continue their existing route.

## 3. System-insights owns core observation

Primary area: `extensions/pi-system-insights/src/`; source behavior then
lived in presentation's status, activity, usage and snapshot modules.

- Add a session-scoped observer and publish `system.session` independently of
  UI mode and without requiring either remote adapter to be installed.
- Capture initial values and update current context on session start/change,
  model/thinking/name changes, turn/tool/message events, prompts and compaction.
- Preserve waiting/compacting/tool/working/idle precedence and nested-tool
  filtering. Observe pending surface forms through the public form contract
  so waiting remains visible when no native Pi dialog is open; do not import
  pi-ask or watch its private events. Exclude the system view's own changes
  from that observation to avoid notification loops.
- Retain session-wide billed totals across branches and compaction records;
  keep current context usage separate. Cache totals only inside this owner
  and invalidate after relevant history changes.
- Reset volatile status/activity on reload and session replacement. Rebuild
  durable totals from history; never infer a live tool from restored history.
- Keep each child session on its own bus. Do not connect children to bb or
  dashboard or store core observation in a process-global singleton.
- Keep existing prompt/tool/skill commands and skill evidence behavior intact.

During this additive PR, old adapters may still use their old observers.
Do not import the new extension from presentation to share the implementation.
Those old observers are removed from each adapter in PRs 6 and 7 and their
unused implementation is deleted in PR 8.

Completion checks: observer operation without adapters, initial publication,
context/model changes, prompt/form waiting, compaction failure, nested tools,
child isolation, reload, missing optional metadata and unchanged usage totals.

## 4. Complete extension-owned views

Primary areas: pi-todo's surface/UI/event integration; pi-subagent's
observation, profile and widget integration; pi-stash and pi-git view builders.

- Publish `todo.summary` and `subagent.summary` through the shared summary kind.
  Include total/completed/active/unreviewed task counts as applicable, and
  queued/running/waiting agent counts needed by current consumers.
- Put main-agent profile identity in pi-subagent's summary even when no child
  agents exist. Publish changes when the profile is selected or restored.
  Neither adapters nor system-insights read the private profile entry.
- Build summaries and display views from the same owned state. Summaries remain
  available when widgets are disabled, all rows are filtered or lists are
  capped. Empty state is distinguishable from an unloaded extension.
- Ensure stash handles/counts and Git totals required by current UIs remain
  structured and accurate beyond displayed row limits; add producer summaries
  where a list cannot carry the required totals.
- Mark only live agent/tool states and clocks as process-bound. Retain review
  markers, task states, Git records, stash metadata and finished-agent history
  in a saved snapshot. Counts derived from live activity settle consistently.
- Keep current action references and their validation. Improve action failure
  feedback where needed by migrated controls; no new destructive actions are
  required by this migration.

Completion checks: hidden widgets, empty/full/filtered lists, truncated lists,
root profile with zero subagents, branch restoration, review changes and
saved process-bound versus persisted state. Keep old section emissions until
both consumers have migrated; do not add a second new representation or registry.

## 5. Questionnaires are owned by pi-ask

Primary area: `extensions/pi-ask/src/`, its existing questionnaire/dialog
components, answer validation and surface registration.

- Refactor open questionnaire ownership so terminal and surface consumers use
  the same pending record and completion path. Publish open/closed form changes
  from the owner rather than having adapters close forms on tool completion.
- For terminal sessions, retain the keyboard questionnaire and allow a live
  dashboard to answer the same record. The first valid answer or cancellation
  wins; all other displays withdraw the completed form.
- For RPC sessions, use the surface form route only when a connected consumer
  advertises support. Otherwise preserve the existing native-dialog route.
  Do not expose that fallback as a second interactive surface form.
- If the last capable consumer disconnects before an answer is accepted,
  withdraw the surface form and fall back to Pi's native dialog when available;
  otherwise cancel with an explicit outcome. Preserve pending questions rather
  than accepting duplicate answers during the handover.
- Preserve child-to-parent question work items and their adoption behavior.
  A child question does not unexpectedly become a user questionnaire.
- Handle abort, reload, cancellation and invalid answers at the owner. Bound
  questionnaire text/options and the number of simultaneous forms; reject an
  overflowing request with an explicit outcome rather than leaving a pending
  tool behind an undeliverable view. Preserve existing answer validation.
- Retain existing open/closed notifications only while the old dashboard needs
  them. Remove them in PR 8 once source searches confirm no remaining consumers.

Completion checks: terminal answer, external answer, concurrent forms,
invalid/duplicate/stale answers, abort, disconnect handover, no form capability,
native-dialog fallback, and unchanged delegated-question behavior.

This PR must not leave the current bb installation waiting on a form it cannot
render. Full consumer end-to-end checks are completed again in PRs 6 and 7.

## 6. Migrate dashboard as a complete consumer

Primary areas: `extensions/pi-dashboard/src/index.ts`, `protocol.ts`,
`reporter.ts`, `src/hub/hub.ts`, `src/hub/page.ts` and dashboard tests/docs.

- Move the reporter to surface collection and generic action requests. Remove
  its presentation dependency and duplicate status/activity/usage observation.
- Migrate the page to shared session/summary/widget/explorer/detail/form models.
  Use one renderer per model kind in dashboard's existing framework; do not
  introduce bb's React framework merely to share rendering code.
- Replace special history/preview/answer endpoints with the generic action
  path. Retain the host-specific Focus path and advertise terminal information
  as host metadata without requiring the system view.
- Keep current terminal-session selection, terminal discovery, hub launch,
  connection replacement, restart grace and page-update behavior.
- Upgrade reporter and hub together: protocol 6 becomes the next available
  version (7 at this baseline). Keep newer-hub takeover and reject older or
  malformed reporters explicitly rather than interpreting their old sections.
- Advertise form support only when connected to the upgraded hub. Handle the
  system view being absent or failed without losing other views or Focus.
- While showing a disconnected record during grace, mark it disconnected,
  settle process-bound fields and refuse actions until the live session returns.

Completion checks: real dashboard with session headers, counts, profile, Git,
stash, task details/review and forms; answer a terminal question from dashboard
and verify the terminal withdraws it. Exercise Focus, reload, hub takeover,
wrong protocol, missing insights and dynamic view removal.

## 7. Migrate bb, its Pi connection and plugin together

Primary areas: `extensions/pi-bb/src/`; `bb-plugin/contract.ts`, `protocol.ts`,
`server.ts`, `sessions.ts`, `archive.ts`, `questions.ts`, `ui/`, fixtures and tests.

- Switch pi-bb to surface collection/actions and remove its presentation
  dependency, duplicate core observers and adapter-owned question cleanup.
- Upgrade both protocol endpoints together: version 2 becomes the next
  available version (3 at this baseline). Use strict envelope/model guards;
  refuse incompatible peers with the existing useful restart/reinstall outcome.
- Migrate headers, context counts, session summaries, row badges, stash picker,
  stash count, Git card, activity and usage to the structured views. Keep cards
  and explorers on generic renderers; support session/summary/form kinds.
- Raise bb pending interactions from live form models and submit the embedded
  action reference. Withdraw interactions when the form disappears, the session
  changes or the connection loses its capability. Fixtures and saved snapshots
  do not raise real questions.
- Replace the complete received view set on every update. Preserve per-thread
  credentials, newest-connection ownership, pending request correlation and
  reply-to-requester behavior. A late result/update cannot affect a replacement.
- Normalize saved views using surface's shared rules; only included details
  open without Pi. New live snapshots fully replace saved data.
- Version saved snapshot records. Decided policy: invalidate unsupported old
  display caches, with no migration, and repopulate on the thread's next live
  turn. Never delete Pi session files, transcripts, tasks or stash. See the
  decision below.
- Preserve local navigation, stash-handle insertion and the existing prompt
  trimming behavior. Update fixture/gallery data and `docs/bb/ui-slots.md`.

Completion checks: every real bb slot, live form answer, hidden-widget counts,
profile without children, saved-card regression, cache version handling,
reconnection, replacement, missing insights, action failures and wrong protocol.
Run the plugin's own typecheck/tests and real-bb screenshot spacing check.

## 8. Delete the old path and enforce the boundary

Delete `packages/pi-presentation` and remove its imports, root workspace and
file dependency, lockfile references and obsolete tests/docs. No replacement
package is created.

Remove extension-specific section projections, fixed task-history/stash-preview/
answer request aliases and the old todo/stash/Git/subagent snapshot bus events
and payload types once searches confirm no consumers remain. Keep extension
internal state builders still used by views or tools; matching a name containing
"snapshot" is not sufficient reason to delete useful domain logic. Remove
ask open/closed events only after the same consumer check. Keep unrelated
lifecycle and work-item events.

Add a tested bundle check that package import maps and dependencies never name
an extension workspace; cover relative package-to-extension source imports too.
Record the architectural rule in `AGENTS.md`. Check bb contract imports and
standalone hub loading so deleting presentation leaves no client type backdoor.

Update the root README, surface/system-insights/dashboard/bb documentation and
both plans to the implemented architecture. Replace stale examples and import
paths. Changelog entries remain the weekly workflow's responsibility.

Final acceptance: zero old section consumers or presentation references in
runtime code/manifests; no package-to-extension dependency; both applications
operate independently with the same views and actions; all required checks pass.

## Checks and release discipline

For each implementation PR, run `npm run check`, `npm test` and
`npm run verify:bundle`. Run focused workspace checks while developing, then
the repository checks before merging. For bb changes also run its separate
`npm run typecheck`, `npm test` and `bb-shot.mjs --expand --check` workflow.

Add meaningful behavior tests with the PR that introduces the behavior.
Do not defer lifecycle, form handover, byte-bound or restored-state tests to
cleanup. Exercise real dashboard and bb flows at their respective migrations.

Deploy each adapter with its matching receiver. Existing separately installed
bb plugins must be updated with the bundle; dashboard's running hub must restart
through its version handshake. Give an explicit mismatch outcome rather than
adding a permanent old-wire translation path. Commits disable GPG signing as
required by `AGENTS.md`.

## Saved-cache decision and defaults

The one user-visible policy that was open before PR 7 is decided:

| Decision                                                      | Decided                                                                 | Consequence                                                                                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Preserve older saved bb display snapshots or invalidate them? | Invalidate: version the saved records, and migrate none of the old ones | Old threads temporarily lose the extra Pi cards until their next live turn; underlying Pi session data is untouched |

A saved record the plugin cannot load (an older version's, or a malformed one)
is treated as if it did not exist, and the thread repopulates on its next live
turn. The plugin logs one warning naming how many records it ignored. There is
no archive migration and no second runtime representation.

Other implementation defaults are explicit in this plan: standalone RPC keeps
native dialogs; machine summaries survive hidden widgets; form routing uses
live capability discovery; disconnected runtime state settles without altering
persisted task states; existing transport size ceilings remain. Exact field
names and module splits can be finalized in PR 1 without reopening ownership.
There are no outstanding architectural blockers or required SDK changes known
from the current code review.

## As implemented

All eight PRs are merged. Where the plan above names a module that no longer
exists, this is where the work ended up:

| Concern                       | Where it lives now                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session, summary, form models | `packages/pi-surface/src/session.ts`, `summary.ts`, `form.ts`; delivery and action shapes in `delivery.ts`                                           |
| Collection and lifecycle      | `collectViews`/`collectDelivery` (`collect.ts`), `batchViews` (`batch.ts`), `advertiseFormConsumer` (`consumers.ts`), `settleSnapshot` (`settle.ts`) |
| Core observation              | `extensions/pi-system-insights/src/session/`, publishing `system.session`                                                                            |
| Extension summaries           | `todo.summary`, `subagent.summary` (with the main-agent profile), `stash.summary`, `git.summary`                                                     |
| Questionnaires                | pi-ask's `ask.questions` form, answered through `ask.submit` and `ask.cancel`                                                                        |
| Dashboard                     | Reporter and hub on protocol 7: `collectDelivery`, generic action requests, Focus as a host request                                                  |
| bb                            | pi-bb and `bb-plugin/` on protocol 3; versioned saved snapshots, old ones ignored                                                                    |
| Dependency direction          | `scripts/package-boundary.mjs`, run by `npm run verify:bundle`; the rule is in `AGENTS.md`                                                           |

PR 8 deleted `pi-presentation` with its section projections, wire types and
core-session trackers. It also removed what only presentation consumed: the
`todo:snapshot`, `stash:snapshot`, `git:snapshot` and `subagent:snapshot` bus
events and their payload types; the `todo.history` and `stash.preview` actions,
the `stash:preview` bus request, and pi-ask's `ask.answer` action and
`ask:answer` request behind the old task-history, stash-preview and answer
requests; and pi-ask's `ask:opened`/`ask:closed` events. The builders the views
and tools still use stayed: pi-git's `gitSnapshot` (`src/snapshot.ts`),
pi-subagent's `buildSubagentSnapshot`, pi-stash's `stashEntryJson` and pi-todo's
review and claim state. Lifecycle (`subagent:*`) and work-item events are
unchanged.
