# Views-only sessions: system insights, surface, dashboard and bb

Status: planned · follows [RPC surfaces](rpc-surfaces.md), packages 6 and 7;
supersedes that plan's original dashboard-removal package 8

The [implementation plan](views-only-implementation.md) specifies the eight-PR
order, dependencies, cutover checks and the decided saved-cache policy.

## Goal

- Each extension owns its state and publishes it through `pi-surface` views
  and actions. Packages never import extensions.
- `pi-system-insights` owns observation of Pi's core session information and
  publishes it as another structured surface view.
- `pi-surface` owns the shared models, view collection and action routing.
  Remove `pi-presentation`; do not introduce a `pi-snapshot` package.
- Update both `pi-dashboard` and bb to consume the shared views. Dashboard
  remains supported and retains terminal Focus.
- Deliver one complete snapshot per session. Each received snapshot replaces
  the previous one; there are no incremental updates to merge.

Non-goals: changing Pi's ordinary chat/tool-output channel, sharing specialized
keyboard interfaces such as the subagent watch overlay, and resolving the
separate import cycle between `pi-foundations` and `pi-ui`.

## Current duplication

`pi-presentation` has 1,280 source lines, including comments, blank lines and
types. It knows `pi-git`, `pi-stash`, `pi-todo`, `pi-subagent` and `pi-ask`.

| Part                                  | Lines | Responsibility                                       |
| ------------------------------------- | ----- | ---------------------------------------------------- |
| Wire types                            | 324   | Session information and extension-specific sections  |
| Section projections                   | 447   | Translate extension events into older sections       |
| Service                               | 207   | Cache sections, collect views and forward requests   |
| Session trackers and snapshot builder | 302   | Core status, activity, usage and session information |

For example, todo state currently leaves pi-todo both as an older section and
as widget/explorer views. Both are delivered to bb; different UI locations
read different representations. Dashboard reads only sections and strips views.
The older task-history, stash-preview and answer request names also wrap
actions already owned by the extensions.

The current bb saved-session handling settles the older agent section but
leaves shared views untouched. This creates a risk of restored cards showing
running agents after Pi has stopped. It is visible in code and has not yet
been reproduced in bb.

## Ownership

| Owner                | Produces or handles                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pi-system-insights` | Core session identity, selected model/thinking, context usage, status, recent tool activity and session token/cost totals |
| Other extensions     | Their own state, main-agent profile information, widgets, explorers, questions and actions                                |
| `pi-surface`         | Portable view models and validation, per-session registries, collection, error/size bounds and action dispatch            |
| `pi-ui`              | Terminal rendering and input over shared models                                                                           |
| `pi-dashboard`       | Dashboard rendering, hub connection, terminal discovery and Focus                                                         |
| `pi-bb`              | Connection to the bb plugin, complete-snapshot delivery and incoming action requests                                      |
| bb plugin            | Latest received snapshots, saved snapshots, bb rendering and forwarding actions to live sessions                          |

Neither surface nor the adapters read another extension's private session
entries. In particular, pi-subagent exposes the main-agent identity through
its own view; the generic snapshot builder no longer reads `agent:profile`.
Extend the shared vocabulary where a consumer needs structured profile data.

## Views and delivery snapshots

These are different objects:

- **System view:** core information owned by system-insights. It does not
  enumerate or embed other views.
- **Delivery snapshot:** a small envelope containing connection/session
  identity, protocol information and the complete set of collected views,
  including the system view. It is not a registered view and has no domain
  state of its own.

Surface's collector reads each registered provider when a delivery is built.
View reads are side-effect-free: reading never announces another change.
Adapters batch change notifications and use the collector; they do not keep
their own merged copies of extension state. A missing, hidden or removed view
is absent from the next complete snapshot and therefore disappears at the
receiver. One failing view becomes an error entry without blocking other views.

Receivers replace their previous complete snapshot. Dashboard's hub keeps its
latest received session records for its page; the bb plugin keeps the latest
record and saves it for thread restoration. These are received snapshots,
not authoritative extension state. A new live connection replaces the saved
record; do not merge stale saved fields into a live snapshot. Preserve existing
connection identity checks so an older process cannot overwrite its replacement.

Actions travel back through the appropriate connection and surface's action
registry to the owning extension. Results return along that same connection;
any resulting state change also produces a new complete snapshot. Ordinary
chat and tool output continue through Pi's existing provider channel.
Dashboard's host-specific Focus request remains in its adapter.

## New shared structures

New surface structures are in scope; avoid encoding machine-readable values
in formatted text.

- Add a first-class `session` view kind and portable model for core session
  information: identity/name/directory, model/thinking/context, status and its
  timestamp, recent activity, token/cost totals, process start and Pi version.
  System-insights provides `system.session`. Surface defines the data shape
  without importing the extension or Pi's runtime. Dashboard and bb can use
  its structured fields in their headers and session summaries.
- Add a `form` view kind for questionnaires, including questions, options,
  multi-select and a submit action reference. pi-ask owns open forms and answer
  validation; dashboard and bb both render and submit this model. The terminal
  can keep its specialized questionnaire component over the same owned state.
- Add a `summary` view kind with explicit numeric counts and optional
  producer-owned profile identity for badges and session summaries. Summaries
  remain available when widgets are hidden or display lists are truncated.
  Consumers never parse counts from `meta` or labels.
- Define process-bound status/clock semantics for saved views. Settling a saved
  snapshot marks live activity inactive and removes live forms. Do not rewrite
  persisted task states simply because they share an icon with runtime states.
  Apply the same semantics in dashboard and bb wherever saved data is shown.

An unavailable system-insights extension does not prevent delivery of other
views or routing of their actions. The delivery envelope retains the minimum
identity needed to route the session; consumers tolerate a missing system view.
System-insights does not depend on bb or dashboard to run.
For RPC questionnaires, pi-ask uses surface forms only when a connected
consumer advertises that it can answer them; otherwise native dialogs remain
available. Capability loss triggers explicit handover or cancellation.

## Core observation in system-insights

Move the existing core status, activity and usage logic into system-insights,
with session-scoped lifecycle handling. Remove duplicate core observation from
dashboard and pi-bb once both read `system.session`.

- Start observation early enough to capture the first session events, and
  announce a usable initial view. Reads use the current session context.
- Reset process-bound activity on session replacement, shutdown and reload;
  dispose registrations so the same session bus has no duplicate providers.
  Child sessions retain their own observers and registries.
- Preserve status precedence: waiting for input, compacting, running a tool,
  working, then idle. Retain current filtering of nested tool calls.
- Preserve whole-session billed usage across abandoned branches and compaction
  records. Current context usage and branch-local data keep their own scopes.
  Cache usage totals inside their owner and invalidate when session history
  changes; do not rescan all history for every status-only refresh.
- Announce changes on relevant lifecycle, model, thinking, name, context and
  history changes. Batch transport publishes without turning reads into writes.
- Keep prompt/tool/skill inspectors on demand. Do not include prompt contents
  or tool schemas in every status update.

## Dashboard and bb migration

Dashboard is an active consumer of this design. Update its page and hub to
render the same session, widget, explorer, detail and form models as bb, and
send generic action requests. Preserve its terminal-session selection,
terminal discovery, Focus and connection lifecycle in its own adapter.

Both consumers migrate their header, activity, usage, context counts, session
summary, badges, stash picker, Git displays and questionnaires to shared views.
The bb stash picker still inserts the selected handle locally. Filtering,
switching tabs and opening an included detail remain local UI behavior; loading
missing details or marking updates reviewed invokes the owning action.

Do not move the old projections into dashboard. Migrate their consumers, then
delete the projections and aliases when both consumers have stopped using them.
No permanent compatibility layer is added to protect the older data shape.

## Work packages

The [implementation plan](views-only-implementation.md) splits this work into
eight reviewable PRs: shared contracts; collection/lifecycle; system-insights;
extension summaries; forms; dashboard; bb; final deletion and enforcement.
This PR remains documentation only.

Transitional old data may remain only until both migrations land; the final
cleanup removes it rather than relocating it.
Do not silently reinterpret an older wire protocol as the new shape: bump and
check protocol versions for both dashboard and bb, and handle old saved bb
snapshots explicitly with a migration or invalidation.

The collector keeps the existing 256 KB per-view bound and isolates provider
errors. Preserve receiver message limits and verify the complete envelope fits;
a per-view bound alone is not a bound on a session with many views.

## Completion and verification

- No package import map names an extension. Add the rule to `verify:bundle`
  and `AGENTS.md`; no exceptions for presentation or session collection.
- Neither dashboard nor bb reads extension sections or parses machine values
  from display strings. Both show the same observed session information and
  dispatch actions through surface.
- Verify initial publication, missing system-insights, branch/session changes,
  reload, replacement connections, restored snapshots, view disappearance,
  provider errors and size limits. Check usage totals retain their scope.
- Exercise dashboard Focus, task review/history, stash preview and form answers
  in both consumers; verify supported interaction against live sessions.
- Retain a regression fixture for the stale-running saved-card case and
  reproduce it in bb where possible. Include new session/summary/form models
  in renderer tests; a missing live reproduction does not block a proven fix.
- Run `npm run check`, `npm test` and `npm run verify:bundle` for implementation
  changes. For bb changes, also run its own typecheck/tests and
  `bb-shot.mjs --expand --check`; update `docs/bb/ui-slots.md`.

Changelogs are maintained by the weekly workflow. Commits use
`git -c commit.gpgsign=false commit`.
