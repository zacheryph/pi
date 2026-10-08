---
issue: 864
issue_title: "pi-subagents: regular TUI can go blank when background AgentWidget starts; resize restores it"
---

# Bound the agents widget to the terminal viewport

## Release Recommendation

**Release:** ship independently

No architecture-roadmap step references [#864]; Phase 22 and its follow-on are closed, so this issue belongs to no open release batch.
It is a user-visible defect fix with no dependency on other in-flight work.

## Problem Statement

A third-party reporter running Pi 0.84.4 with `tuiMode: "regular"` sees the terminal go visually blank shortly after a background subagent starts and the above-editor agents widget mounts.
Pi keeps running; resizing the terminal repaints everything.
The reporter attributes this to the widget's 80 ms render loop amplifying a renderer state desynchronization and proposes an extension-side mitigation: slow the interval to 250 ms, change-gate `requestRender()` on a cached snapshot, add a setting to disable the widget, and add a regression test.

The issue was filed by `Kacep91`, not the repository owner, so the direction was confirmed with the operator before planning rather than transcribed from the body.
The operator's decision (recorded in the retro) is: bound the widget's height to the terminal viewport, stop the animation timer when nothing is running, slow the tick to 250 ms flat, and ship no disable setting.

## What was measured

The reporter's diagnosis names the widget loop but not the path from that loop to a blank screen.
That path was traced and then reproduced.

Pi's regular-mode renderer keeps the **entire transcript** as live components and re-renders all of them on every `doRender()` (`@earendil-works/pi-tui@0.84.4/dist/tui.js:58-65`, `dist/tui-main-screen.js`).
There is no viewport clipping, so each `requestRender()` walks the whole tree.
When the parent is idle at the prompt, Pi's own animated components are quiescent: `clearStatusIndicator()` swaps in `IdleStatus`, whose `render` returns two static blank lines (`@earendil-works/pi-coding-agent@0.84.4/dist/modes/interactive/components/status-indicator.js:51-58`).
In the reported scenario the agents widget is therefore the **only** thing driving the renderer.

The destructive path is one guard:

```javascript
// dist/tui-main-screen.js:404-411
// Differential rendering can only touch what was actually visible.
// If the first changed line is above the previous viewport, we need a full redraw.
if (firstChanged < prevViewportTop) {
  logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
  fullRender(true);
  return;
}
```

`fullRender(true)` emits `\x1b[2J\x1b[H\x1b[3J`, clearing the screen **and the scrollback**, then repaints every line (`dist/tui-main-screen.js:237-266`).
`prevViewportTop` settles at `totalRenderedLines - terminalRows` (`dist/tui-main-screen.js:549`).
The widget's spinner sits on the first running agent's header line, so it is `firstChanged` on every tick, and the guard fires whenever the lines from that header to the bottom of the buffer exceed the terminal's rows.

Measured against the real `TuiMainScreen` with a fake `Terminal`, the real `AgentWidget`, and 100 spinner ticks (throwaway spike, since deleted):

| Widget lines | Terminal rows | `fullRender(true)` per 100 ticks | Bytes written per tick (2000-line transcript) |
| ------------ | ------------- | -------------------------------- | --------------------------------------------- |
| 5            | 12            | 0                                | 230                                           |
| 9            | 12            | 100                              | not sampled                                   |
| 9            | 14            | 0                                | not sampled                                   |
| 12           | 14            | 100                              | 53,699                                        |
| 12           | 24            | 0                                | 596                                           |

Every tick in the failing rows clears the screen and the scrollback.
At the current 80 ms cadence that is roughly 671 KB/s of clear-and-repaint traffic, about 90 times the safe case, which is what a terminal renders as "blank", and why a resize (a single clean full redraw) restores it.
The widget grows to 12 lines at six background agents, and `renderWidgetLines` has no knowledge of `tui.terminal.rows` today: `MAX_WIDGET_LINES` is a hard-coded `12` (`src/ui/widget-renderer.ts:127`).

A second measurement redirects the reporter's item 2.
While an agent is **running**, the widget's content genuinely changes every tick (spinner frame plus the `formatMs` elapsed readout), so gating `requestRender()` on a content snapshot saves nothing.
But when only **finished or queued** agents are displayed, the 80 ms timer keeps running and the rendered lines are byte-identical: 0 bytes written, and 0.34 to 0.41 ms of wasted whole-tree re-render per tick on a 2000-line transcript, indefinitely, because `finishedTurnAge` only ages on `turn_start` and an idle user never advances it.

## Goals

- Make Pi's `firstChanged < prevViewportTop` full-redraw path unreachable from this widget at any terminal size, by deriving the widget's line budget from `tui.terminal.rows`.
- Stop the animation timer whenever no subagent is `running`, so a queued-only or finished-only widget costs nothing.
- Slow the animation cadence to 250 ms.
- Pin both behaviors with tests, including one that drives Pi's real `TuiMainScreen` and asserts its full-redraw counter stays at zero.

This change is **not breaking**.
No public API, `SubagentRecord` field, event payload, settings key, or default value changes.
The observable differences are cosmetic and unobservable to consumers: a shorter widget in a short terminal and a slower spinner.

## Non-Goals

- Fixing Pi's renderer guard.
  `fullRender(true)`-on-any-change-above-the-viewport is a `pi-tui` design decision; `earendil-works/pi#4785` proposed starting the diff scan at `prevViewportTop` and its PR (`earendil-works/pi#4784`) was closed unmerged, while the issue itself was closed as completed.
  Verified: `git diff v0.84.4..HEAD -- packages/tui/src/tui-main-screen.ts` in the tracking checkout changes only the `PI_DEBUG_REDRAW` to `PI_TUI_DEBUG_REDRAW` rename and the log-file paths, so the guard is unchanged in Pi 0.86.0 and waiting upstream is not a plan.
- A setting to disable the widget or its animation (the reporter's item 3).
  Declined by the operator: mechanism is forever and docs are reversible, and once the height bound removes the hazard the knob guards nothing.
- Caching a rendered-line snapshot to change-gate `requestRender()` (the reporter's item 2 as written).
  Measurement shows the saving lives entirely in the no-running-agent case, which the timer-lifetime rule captures without any new cached state.
- Matching Pi's `Loader` cadence at runtime.
  Pi's own spinner default is also 80 ms (`../../pi/packages/tui/src/components/loader.ts:12`), but `DEFAULT_INTERVAL_MS` is module-private and `InteractiveMode.workingIndicatorOptions` is `private`; `ctx.ui.setWorkingIndicator()` is a setter with no getter, so there is no read path to track.
  Pi also pays its 80 ms only while the parent is working, the opposite duty cycle to ours.
- Any change to `src/ui/glyphs.ts`, `src/ui/display.ts`, `src/ui/session-navigator.ts`, `src/ui/transcript-content.ts`, or the `/subagents:sessions` overlay.
- Anything in [#733]'s overlay-compositing path, which the operator already checked on the issue and found to be a distinct mechanism.

## Background

`AgentWidget` (`src/ui/agent-widget.ts`, 332 lines) implements `SubagentManagerObserver` and self-drives its own render loop, a Phase 18 outcome ([#423]).
Three observer callbacks (`onSubagentStarted`, `onSubagentCreated`, `onSubagentResuming`) call the private `startLoop()`, which calls `ensureTimer()` and then `update()`.
`ensureTimer()` is `this.widgetInterval ??= setInterval(() => this.update(), 80)`.
The interval is cleared in exactly two other places: `clearWidget()`, reached from `update()`'s idle path when `!hasActive && !hasFinished`, and `dispose()`.

`update()` reads `listBackgroundAgents()`, seeds linger tracking, and calls `assembleWidgetState` to get `{ runningCount, queuedCount, hasFinished, hasActive }`.
It registers the widget factory once and thereafter calls `this.tui?.requestRender()`.
The factory callback receives the TUI through the narrow `TuiSurface` interface (`src/ui/agent-widget.ts:54-57`), which currently declares only `terminal.columns` and `requestRender()`.

`renderWidgetLines` (`src/ui/widget-renderer.ts:258`) is pure and takes a six-field params object: `agents`, `registry`, `spinnerFrame`, `terminalWidth`, `theme`, `shouldShowFinished`.
It caps the body at `MAX_WIDGET_LINES - 1` and, past that, hands off to `assembleOverflow`, which prioritises running over queued over finished and appends a `+N more (…)` summary line.
That overflow machinery is exactly what a smaller budget needs; only the number feeding it changes.

The package already has a convention for reading the terminal's height.
`TranscriptPane.viewportHeight` (`src/ui/session-navigator.ts:251-253`) reads `this.tui.terminal.rows` and clamps with a named-constant triple:

```typescript
const CHROME_LINES = 2;
const MIN_VIEWPORT = 3;
const VIEWPORT_HEIGHT_PCT = 70;

private viewportHeight(totalLines: number): number {
  const cap = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100) - CHROME_LINES;
  return Math.max(MIN_VIEWPORT, Math.min(totalLines, cap));
}
```

The new budget helper follows that shape.
It uses the absolute-reserve form rather than the percentage one, because the quantity being reserved is a literal count of dock lines below the widget, not a share of the screen.

AGENTS.md constraints that apply.
`widget-renderer.ts` must stay SDK-independent (plan 0539 Non-Goals), so the new parameter is a plain `number`, not an SDK type.
Every semantic display glyph lives in `src/ui/glyphs.ts`; this change adds none.
Pi's own source is checked out at `../../pi` and tracks Pi's `main` (0.86.0), ahead of the pinned 0.84.4 peer floor, so version-sensitive claims above are cited against the pinned dist and the checkout separately.

## Design Overview

### The line budget

The condition that keeps the widget out of the destructive path is

```text
(widgetLines - 1) + dockLinesBelowWidget <= terminalRows
```

where the `- 1` is the static heading above the first animated line, and `dockLinesBelowWidget` is the editor plus any below-editor widgets plus the footer.
The extension cannot query that value: `previousViewportTop`, `previousLines`, and `maxLinesRendered` have no accessors, and no API reports how tall the rest of the dock is.
So the budget reserves it as a documented constant.

```typescript
// src/ui/widget-renderer.ts
/** Widget body plus heading never exceeds this, however tall the terminal. */
const MAX_WIDGET_LINES = 12;
/** Below this the widget stops being readable; a pane this short cannot be made safe anyway. */
const MIN_WIDGET_LINES = 3;
/**
 * Dock rows below the widget the budget must leave alone: Pi's editor plus its
 * footer. Measured at 5 (3 + 2) against pi-tui 0.84.4; reserved at 6 so a
 * taller editor still leaves the widget's first animated line inside the
 * viewport, which is what keeps Pi's `firstChanged < prevViewportTop` guard
 * from clearing the screen on every spinner tick (#864).
 */
const DOCK_LINES_BELOW_WIDGET = 6;

/** Lines the widget may render at this terminal height, heading included. */
export function widgetLineBudget(terminalRows: number): number {
  return Math.max(
    MIN_WIDGET_LINES,
    Math.min(MAX_WIDGET_LINES, terminalRows - DOCK_LINES_BELOW_WIDGET),
  );
}
```

Checked against the measured threshold (`budget <= rows - 4` for the sampled five-line dock), the budget leaves a two-row cushion at every height from 7 rows up, and clamps to the existing 12 from 18 rows up, so a normal-sized terminal renders exactly what it renders today.
At 6 rows and below the dock alone nearly fills the screen and no widget height is safe; the floor of 3 is the honest stopping point, not a guarantee.

`renderWidgetLines` gains a seventh param and uses the budget in place of the constant:

```typescript
export function renderWidgetLines(params: {
  agents: readonly WidgetAgent[];
  registry: AgentConfigLookup;
  spinnerFrame: number;
  terminalWidth: number;
  terminalHeight: number;
  theme: Theme;
  shouldShowFinished: (agentId: string, status: string) => boolean;
}): string[];
```

The params object stays a single cohesive set that one consumer passes whole, so growing it to seven fields is not the dependency-bag smell: every field is read on every call, and no caller supplies a subset.

`TuiSurface` grows the field the budget needs, and the call site reads it:

```typescript
export interface TuiSurface {
  readonly terminal: { readonly columns: number; readonly rows: number };
  requestRender(): void;
}
```

Pi's `Terminal` interface declares `get rows(): number` (`@earendil-works/pi-tui@0.84.4/dist/terminal.d.ts:26`), and the object a widget factory receives forwards the whole `TuiBase` surface, so no new capability is being assumed.

### The timer's lifetime

Today the timer's start is event-triggered from three callbacks and its stop is decided in two unrelated places.
After this change one rule decides both, in `update()`, from state the widget has already assembled:

```typescript
// inside update(), after assembleWidgetState
this.setTimerRunning(state.runningCount > 0);
```

Registration is unchanged: the widget stays mounted while `hasActive || hasFinished`, so a queued-only or finished-only widget is still visible and still accurate.
Only the animation stops, because nothing in those renderings changes between ticks.
`startLoop()` and `ensureTimer()` disappear and all six observer callbacks become plain `this.update()` calls.

The existing doc comment on `onSubagentResuming` already asserts this rule ("the timer stops once nothing is running"), which the code does not currently hold: `clearWidget` stops it only when nothing is active **and** nothing finished.
The change makes the comment true.

The whole lifecycle of `widgetInterval` after the change, in one place:

| Transition | Where                                         | Condition                                                                    |
| ---------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| Set        | `setTimerRunning(true)` from `update()`       | `runningCount > 0` and no interval exists                                    |
| Cleared    | `setTimerRunning(false)` from `update()`      | `runningCount === 0`                                                         |
| Cleared    | `setTimerRunning(false)` from `clearWidget()` | idle path, subsumed by the rule above but kept for locality                  |
| Cleared    | `dispose()`                                   | unconditional, and `uiCtx` is dropped so a later `update()` cannot re-arm it |
| Read       | the `setInterval` callback                    | every `WIDGET_UPDATE_INTERVAL_MS`                                            |

`dispose()`'s inertness guarantee ([#849]) is preserved: `update()` still returns at its first line when `uiCtx` is undefined, before it reaches the timer decision.

### The cadence

`80` becomes a named `WIDGET_UPDATE_INTERVAL_MS = 250`.
`formatMs` renders tenths of a second (`src/ui/display.ts:107-109`), so the elapsed readout advances by two or three tenths per frame instead of one; it still reads as a live timer.
With the timer now confined to running agents, this cadence applies only to the window where the widget is genuinely animating.

## Module-Level Changes

| File                                | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/widget-renderer.ts`         | Add `MIN_WIDGET_LINES`, `DOCK_LINES_BELOW_WIDGET`, and the exported `widgetLineBudget(terminalRows)`; add `terminalHeight` to `renderWidgetLines`' params; replace `const maxBody = MAX_WIDGET_LINES - 1` (line 288) with `widgetLineBudget(terminalHeight) - 1`. No change to `categorizeAgents`, `assembleWithinBudget`, `renderFinishedLine`, or `renderRunningLines`. **Departed at implementation:** `buildSections` and `assembleOverflow` also changed — see the departure note below. |
| `src/ui/agent-widget.ts`            | `TuiSurface.terminal` gains `readonly rows: number`; `renderWidget` passes `terminalHeight: tui.terminal.rows`; add `WIDGET_UPDATE_INTERVAL_MS = 250` and `private setTimerRunning(shouldRun: boolean)`; delete `startLoop()` and `ensureTimer()`; `onSubagentStarted`, `onSubagentCreated`, and `onSubagentResuming` call `this.update()`; `update()` calls `setTimerRunning(state.runningCount > 0)`; `clearWidget()` and `dispose()` clear through the same helper.                        |
| `test/widget-renderer.test.ts`      | Add a local params builder over the seven fields; add `widgetLineBudget` unit tests; add a short-terminal overflow-collapse case. Seven existing `renderWidgetLines({…})` call sites (verified by grep) route through the builder.                                                                                                                                                                                                                                                            |
| `test/ui/agent-widget.test.ts`      | Add a local `stubTui()` builder; the two `{ terminal: { columns: 200 }, requestRender: () => {} }` literals (lines 234 and 355, verified by grep) gain `rows`. The `onSubagentCreated` timer expectation in the `"self-drives from lifecycle notifications"` block inverts from `getTimerCount() === 1` to `0` for a queued agent; add a finished-only case and a running case.                                                                                                               |
| `test/ui/widget-viewport.test.ts`   | New. Drives Pi's real `TuiMainScreen` against a fake `Terminal` with the real `AgentWidget` mounted, and asserts `tui.fullRedraws` stays 0 across a table of terminal heights and agent counts.                                                                                                                                                                                                                                                                                               |
| `docs/architecture/architecture.md` | Line 424: "every 80 ms" becomes the new cadence, and the sentence gains the viewport bound and the running-only timer rule.                                                                                                                                                                                                                                                                                                                                                                   |
| `README.md`                         | The `## UI` section (line 67 onward) gains a sentence that the widget collapses to a `+N more` summary when the terminal is too short to show every agent, next to the existing queued-collapse sentence at line 195.                                                                                                                                                                                                                                                                         |

Files in the blast radius predicted **unchanged**, with the claim each rests on:

| File                                                       | Claim                                                                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                             | Constructs `new AgentWidget(manager, registry)` and registers it as an observer; no constructor or observer-method signature changes.                                                                                           |
| `src/handlers/widget-events.ts`                            | Calls only `setUICtx`, `onTurnStart`, and `dispose` (verified by grep); all three keep their signatures.                                                                                                                        |
| `src/ui/glyphs.ts`                                         | `SPINNER` is read by index, not redefined; no glyph is added or changed.                                                                                                                                                        |
| `src/ui/display.ts`                                        | `formatMs` and `describeActivity` are called identically; only the interval between calls changes.                                                                                                                              |
| `src/ui/session-navigator.ts`                              | Reads `terminal.rows` through its own `tui` reference, not `TuiSurface`; the interface this plan widens is local to `agent-widget.ts`.                                                                                          |
| `.pi/skills/package-pi-subagents/SKILL.md`                 | Its UI-domain row names modules and responsibilities, not the poll cadence; grepped for `80` and `poll`, and the only `poll` hit is the dependency-flow line `widget ─polls─→ Subagent records (listAgents)`, which stays true. |
| `docs/configuration.md`                                    | Grepped for `widget`: the sole hit is the `display_name` frontmatter row, unrelated to height or cadence.                                                                                                                       |
| `docs/architecture/architecture.md` churn table (line 769) | `ui/agent-widget.ts` scores 15.2 on commits × complexity; churn and complexity tables are recomputed at phase boundaries, not per issue.                                                                                        |

### Departure: `assembleOverflow` counts hidden queued agents

This plan predicted no change to `assembleOverflow`, resting on the premise that its queued-drop path was unreachable in practice: reaching it needed five simultaneous running agents, because the body budget was a fixed 11.
Lowering the budget to `widgetLineBudget(terminalRows)` falsified that premise.
At a 10-row terminal the budget is 4, and one running plus one queued plus one finished agent is enough: the running pair consumes the body, the queued row is dropped with no counter, and the summary reports `+1 more (1 finished)` while hiding two agents.

The pre-completion reviewer found it and the operator chose to fix it in this branch rather than defer, because the reachability is this change's own doing and it lands at exactly the small-pane sizes the issue is about.
`WidgetSections` gained a `queuedCount`, and the summary now reports queued alongside running and finished, counted by agents rather than by the single row that collapses them.
Raising the budget floor to hide the path again was considered and declined: it would trade an honest floor for a widget the viewport bound cannot protect.

`startLoop` and `ensureTimer` are both `private` and have no callers outside `src/ui/agent-widget.ts` (verified by grep across `src/` and `test/`), so removing them breaks nothing at the type level.
`MAX_WIDGET_LINES` is module-private and referenced only in `widget-renderer.ts` and one comment in `test/widget-renderer.test.ts:295`.

## Test Impact Analysis

New unit tests the change enables:

- `widgetLineBudget` is a pure exported function, so the clamp can be driven as a table over terminal heights (6, 7, 10, 12, 14, 16, 18, 24, 60) with no widget, no TUI, and no timers.
  Nothing in the package could express this before, because the cap was a module-private literal.
- The `TuiSurface` stub could never observe a redraw decision, because it is a stub.
  Pi exports `TuiMainScreen` (`@earendil-works/pi-tui` index), its `Terminal` collaborator is an interface, its constructor takes `(terminal, showHardwareCursor?, logDirectory?)`, `renderNow()` is public, and `get fullRedraws()` exposes the counter the guard increments.
  That is enough to assert the invariant against the real renderer rather than against a model of it, which is what the spike already did.

Existing tests that must change:

- The three `vi.getTimerCount()` assertions in `"AgentWidget — self-drives from lifecycle notifications"`.
  `onSubagentStarted` and `onSubagentResuming` use a `running` fixture and stay at 1.
  `onSubagentCreated` uses a `queued` fixture and inverts to 0; its intent (the callback renders) is preserved by keeping the `lastContent()` assertion.
- The seven `renderWidgetLines` call sites and the two `stubTui` literals, mechanically, through the two builders.

Existing tests that stay as-is because they exercise the layer being changed:

- `AgentWidget.dispose` — "clears the update interval" and "leaves a later `update()` inert" pin [#849]'s teardown guarantee across the timer rewrite.
- `"background-only filtering"` — pins [#444] and [#724] independently of height.
- `"update self-seeds finished agents"` — the linger aging is driven by `onTurnStart`, not the timer, and must survive the timer stopping for finished-only widgets.

The integration test's own input domain is the pair (terminal rows, background agent count), not the shapes I can picture, so it runs as a table across both axes rather than one example, and asserts the same predicate (`fullRedraws === 0`) at every cell.
The failing cells measured before the fix (9 lines at 12 rows, 12 lines at 14 rows) are included so the table would have caught the defect.

## Invariants at risk

| Invariant                                                                                                       | Owner                                | Pinned by                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The widget self-drives its loop from lifecycle notifications, not from inbound spawn-tool calls                 | Phase 18 Step 4, [#423]              | `"self-drives from lifecycle notifications"` in `test/ui/agent-widget.test.ts`, which calls the observer methods directly and asserts the render and the timer. The timer half changes value for the queued case; the "no inbound call needed" half is untouched.                                                                                                       |
| Disposal is final: a notification arriving after `dispose()` cannot re-register the widget or restart its timer | [#849]                               | `"leaves a later update() inert, so a terminal transition cannot re-register it"`. Read: it drives the real `AgentWidget` with a recording `UICtx` and asserts `setWidget` call count does not grow, so it pins the behavior rather than mocking it. The timer decision lands after `update()`'s `uiCtx` guard, so the guarantee is structural, not incidental.         |
| Only background agents appear in the widget                                                                     | ADR-0004 Decision A, [#444], [#724]  | `"background-only filtering"`, asserting on `listAgents()` records with mixed `isBackground`. Unaffected by height or cadence.                                                                                                                                                                                                                                          |
| A finished agent lingers one turn, an errored one two                                                           | [#423] lineage, `shouldShowFinished` | `"seeds a completed agent so it ages out after one turn"` and the error-linger case. **At risk**: these drive aging through `onTurnStart()`, and the timer now stops for a finished-only widget. The tests stay green because aging never depended on the timer, but the plan adds a finished-only timer-count assertion so the coupling is stated rather than assumed. |
| The widget's rendered height is quantitatively bounded                                                          | new here                             | Nothing pins it today; `test/ui/widget-viewport.test.ts` is where it starts. Baseline measured above: 12 lines at 14 rows gives 100 full redraws per 100 ticks. Predicted post-change: 0 at every sampled height, with `widgetLineBudget(14) = 8` and the cushion `8 <= 14 - 4`.                                                                                        |
| `widget-renderer.ts` stays SDK-independent                                                                      | plan 0539 Non-Goals                  | Structural: the new param is a `number` and the new helper imports nothing. `test/widget-renderer.test.ts` constructs plain objects, so an SDK type would not compile there.                                                                                                                                                                                            |

Constituencies, since an invariant can be dead for one reader and load-bearing for another.
The height bound serves the small-pane and tmux-pane operator, who is the one seeing the blank screen; it costs the large-terminal operator nothing, because the budget clamps to today's 12 from 18 rows up.
The running-only timer serves every operator's CPU and the battery of anyone who leaves a completed agent on screen; it costs no one, because the lines it stops redrawing are byte-identical.
The 250 ms cadence costs the operator who watches the spinner closely, which is the one trade the operator accepted explicitly.

## TDD Order

1. **Tidy** — build `renderWidgetLines` params in one place.
   Surface: `test/widget-renderer.test.ts`.
   Add a local builder that supplies today's defaults (`registry`, `spinnerFrame: 0`, `terminalWidth: 200`, `theme`) and accepts overrides; route all seven existing call sites through it.
   Prepares the friction in step 4, where a seventh field would otherwise mean seven hand edits.
   No behavior change; the existing assertions must pass untouched.
   Commit: `test(pi-subagents): build renderWidgetLines params in one place` Killing mutation: change the builder's `terminalWidth` default from 200 to 5; the truncation-sensitive assertions must go red, proving the builder actually feeds the calls.

2. **Tidy** — build the widget TUI stub in one place.
   Surface: `test/ui/agent-widget.test.ts`.
   Extract a local `stubTui()` (and the paired `stubTheme()`, duplicated at the same two sites) from the literals at lines 234 and 355.
   Prepares step 4's `rows` addition, which would otherwise be a two-site edit.
   Commit: `test(pi-subagents): build the widget TUI stub in one place` Killing mutation: make `stubTui()` return `columns: 1`; the projection test's `toContain("reading")` assertion must go red.

3. **Tidy** — give the widget timer one start/stop mechanism.
   Surface: `test/ui/agent-widget.test.ts` (existing tests only).
   Extract `private setTimerRunning(shouldRun: boolean)` holding the `??= setInterval(...)` and the `clearInterval`/undefined-guard pair; call it from `ensureTimer()`, `clearWidget()`, and `dispose()`.
   Name the interval `WIDGET_UPDATE_INTERVAL_MS`, still `80`.
   Behavior-identical: same cadence, same start triggers, same stop conditions.
   This is the mechanism half only; the *rule* still lives at three callbacks and moves in step 5.
   Commit: `refactor(pi-subagents): give the widget timer one start/stop mechanism` Killing mutation: make `setTimerRunning(true)` a no-op; the three `getTimerCount() === 1` assertions must go red.
   Make `setTimerRunning(false)` a no-op; `AgentWidget.dispose` "clears the update interval" must go red.

4. **Red → Green** — bound the widget to the terminal viewport.
   Surfaces: `test/widget-renderer.test.ts` (unit), `test/ui/widget-viewport.test.ts` (new integration), `test/ui/agent-widget.test.ts` (stub gains `rows`).
   Red: table-driven `widgetLineBudget` tests across heights 6, 7, 10, 12, 14, 16, 18, 24, 60; a short-terminal `renderWidgetLines` case asserting the `+N more` collapse; and the integration table asserting `fullRedraws === 0` across (rows, agents) including the two measured failing cells.
   Green: add the constants and `widgetLineBudget`, thread `terminalHeight`, widen `TuiSurface`, pass `tui.terminal.rows`.
   The signature change and all its call sites land in one commit; a split would not type-check.
   Commit: `fix(pi-subagents): keep the agents widget inside the terminal viewport` Killing mutations, one per equivalence class:
   - Make `widgetLineBudget` return `MAX_WIDGET_LINES` unconditionally.
     Kills the budget table's short-terminal rows and every failing integration cell.
   - Remove the `MIN_WIDGET_LINES` floor (return the raw `min`).
     Kills the 6-row and 7-row budget rows only.
   - Pass `terminalWidth` where `terminalHeight` is expected in `renderWidget`.
     Kills the integration cells (100 columns minus the reserve exceeds the ceiling, so the widget renders full height at 14 rows) and leaves the pure unit tests green, which is the point of having both.

5. **Red → Green** — stop the animation when no subagent is running.
   Surface: `test/ui/agent-widget.test.ts`.
   Red: `onSubagentCreated` with a queued agent leaves `getTimerCount() === 0` while `lastContent()` is still a function; a finished-only `update()` leaves the timer stopped and the widget registered; a running agent still starts it; a run that finishes while a queued agent remains stops it.
   Green: replace `startLoop()` with `update()` in the three callbacks, delete `startLoop` and `ensureTimer`, and call `setTimerRunning(state.runningCount > 0)` in `update()` after `assembleWidgetState`.
   Commit: `fix(pi-subagents): stop widget animation while no subagent is running` Killing mutations:
   - Change the predicate to `state.hasActive`.
     Kills the queued-only case, leaves the finished-only case green.
   - Change the predicate to `state.hasActive || state.hasFinished`.
     Kills both the queued-only and finished-only cases.
   - Delete the `setTimerRunning(...)` call from `update()` entirely.
     Kills the running case as well, since nothing starts the timer any more.

6. **Red → Green** — slow the cadence.
   Surface: `test/ui/agent-widget.test.ts`.
   Red: with fake timers, advancing 249 ms after a running agent starts produces no additional render beyond the immediate one, and advancing to 250 ms produces exactly one more.
   Green: `WIDGET_UPDATE_INTERVAL_MS = 250`.
   Separated from step 5 because the mechanism and the tuned number have different failure rates and different instruments.
   Commit: `perf(pi-subagents): slow the agents widget animation to 250 ms` Killing mutation: set the constant back to 80; the 249 ms assertion must go red.

7. **Docs** — record the new behavior.
   `docs/architecture/architecture.md` line 424 and the `README.md` `## UI` section.
   Verify: `rg -n '80 ms' packages/pi-subagents/docs/architecture packages/pi-subagents/README.md` returns nothing, and `pnpm exec rumdl check` passes on both files.
   Commit: `docs(pi-subagents): record the widget's viewport bound and 250 ms cadence`

Verification after step 4 and after step 6: `pnpm --filter @gotgenes/pi-subagents run check`.
Step 4 changes a shared signature, so it is the one that most needs the full type check at its boundary.

## Risks and Mitigations

| Risk                                                                                                                                                                                                              | Mitigation                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOCK_LINES_BELOW_WIDGET = 6` is an estimate of a quantity the extension cannot query. The measured dock was 5 (3-row editor, 2-row footer); a multi-line paste grows the editor and can eat the one-row cushion. | The cushion is two rows against the measured dock at every height from 7 up, so the bound tolerates one extra editor row everywhere and two above 8 rows. The integration table pins the invariant at the measured dock; a taller editor only matters where the dock alone nearly fills the screen, which no widget height can fix. Stated in the constant's doc comment rather than implied. |
| The risk that the height bound is load-bearing at all: without it, does the guard actually fire?                                                                                                                  | Not argued: measured. 100 of 100 ticks trigger `fullRender(true)` at 12 widget lines and 14 rows, and 0 of 100 at 24 rows. The spike exercised the absence of the fix, not its presence.                                                                                                                                                                                                      |
| Stopping the timer for a finished-only widget could freeze content that still changes.                                                                                                                            | Enumerated rather than assumed: `renderFinishedLine` derives its duration from `completedAt - startedAt` (both fixed), and `queuedLine` renders a count. Neither reads `Date.now()`. Every remaining `Date.now()` read is in `renderRunningLines`, which only runs when `runningCount > 0`.                                                                                                   |
| Linger aging could silently stop for a finished-only widget once the timer stops.                                                                                                                                 | Aging runs in `onTurnStart()`, which `widget-events.ts` drives from Pi's `turn_start`, never from the timer. Step 5 adds an explicit finished-only assertion so this is pinned rather than reasoned about.                                                                                                                                                                                    |
| 250 ms coarsens the elapsed readout, whose own granularity is 100 ms.                                                                                                                                             | Accepted by the operator with the trade named. The readout advances two or three tenths per frame instead of one, and only while an agent runs.                                                                                                                                                                                                                                               |
| Pi could change `Loader`'s 80 ms default, leaving our cadence out of step.                                                                                                                                        | By design: there is no read path (module-private constant, private field, setter-only API), and the duty cycles differ, so tracking it was declined in Non-Goals rather than left as an implicit dependency.                                                                                                                                                                                  |
| The integration test couples the suite to Pi's internals.                                                                                                                                                         | It couples to Pi's *public* surface: `TuiMainScreen` and the `Terminal` interface are exported, `renderNow()` and `fullRedraws` are public. A future Pi that fixes the guard makes the test trivially pass, not fail, which is the right failure mode for a test whose subject is our own line budget.                                                                                        |

## Open Questions

- Whether to report the measured reproduction upstream as a `pi-tui` issue.
  The harness is small and the guard is Pi's, but `earendil-works/pi#4785` covers the same mechanism and was closed as completed while its PR was closed unmerged, so the reception is uncertain.
  Not filed as a follow-up issue here, because an upstream comment is the operator's call and a tracking issue for writing one is process noise.
- Whether the `+N more (…)` overflow summary is the right presentation at a 3-line budget, where it consumes a third of the widget.
  Deferred until someone runs Pi in a 9-row pane; the alternative (drop the summary and show one more agent) trades honesty for density and has no reported demand.

[#423]: https://github.com/gotgenes/pi-packages/issues/423
[#444]: https://github.com/gotgenes/pi-packages/issues/444
[#724]: https://github.com/gotgenes/pi-packages/issues/724
[#733]: https://github.com/gotgenes/pi-packages/issues/733
[#849]: https://github.com/gotgenes/pi-packages/issues/849
[#864]: https://github.com/gotgenes/pi-packages/issues/864
