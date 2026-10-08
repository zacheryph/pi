---
issue: 1032
issue_title: "pi-subagents: PgUp/PgDn scroll the parent instead of the session viewer in fullscreen mode"
---

# Page the session viewer natively in fullscreen mode

## Release Recommendation

**Release:** ship independently

The issue belongs to no improvement roadmap or release batch, and it is a self-contained bug fix to the `/subagents:sessions` viewer.

## Problem Statement

In fullscreen mode (Pi's default `tuiMode`), the `/subagents:sessions` viewer's footer advertises `PgUp/PgDn`, but pressing them scrolls the **parent** conversation and leaves the transcript where it is.
Home and End do the same; the issue lists them as working, but they are consumed by the same listener.
Only ↑/↓, `j`/`k`, and Shift+↑/↓ reach the pane, so in fullscreen the footer's hint is wrong and there is no way to jump to the top or bottom.
Regular mode works.

The operator wants the native behavior: bare PgUp/PgDn page the viewer, and some key jumps to the top and bottom, without the viewer hiding the parent's transcript or Pi's footer any more than it does today.

## Goals

- In fullscreen mode, bare PgUp/PgDn page the viewer and Home/End jump to its top and bottom.
- The mouse wheel over the pane scrolls the transcript.
- The viewer's paging and top/bottom keys follow the operator's keybindings (`tui.altScreen.pageUp`/`pageDown`/`top`/`bottom`), and the footer hint names the keys that are actually bound.
- In fullscreen the viewer occupies the same region it does today: bottom-anchored, full width, content-sized up to 70% of the terminal rows, with Pi's footer still visible below it.
- Regular mode keeps the docked, non-overlay mount ADR 0007 requires.
- Non-breaking.
  With default keybindings every key does what it did in regular mode; the fullscreen change is a bug fix (`fix(pi-subagents):`).

## Non-Goals

- Asking upstream for a way for a focused non-overlay component to claim viewport keys.
  [earendil-works/pi#7574] settled that in fullscreen the unmodified keys belong to the transcript, and [earendil-works/pi#7894] added the focused-overlay deferral this plan uses instead.
- Temporarily rebinding `tui.altScreen.*` on Pi's global `KeybindingsManager` while the viewer is open — rejected at the planning gate (process-global state, a crash leaves Pi's paging dead).
- Routing ↑/↓, `j`/`k`, Shift+↑/↓, `q`, and Esc through keybindings.
  None is shadowed in fullscreen; they stay hard-coded.
- Measuring Pi's footer height.
  It lives in Pi's private layout tree; the fixed 3-row margin covers Pi's default footer (see Design Overview).
- Scrolling the parent with the wheel while the fullscreen viewer is open (see Risks).
- `pi-permission-system`'s settings overlay ([#874]) — a different call site and question.

## Background

`TranscriptPane` (`src/ui/session-navigator.ts`) matches keys with hard-coded `matchesKey(data, "pageUp")` and similar.
`SessionNavigatorHandler.handle` mounts it with `ui.custom(factory, { overlay: false })` per `docs/decisions/0007-transcript-viewer-is-not-an-overlay.md`, and ignores the factory's third argument (`_keybindings`).

Verified against the compiled `@earendil-works/pi-tui@1.0.0` (`dist/tui-alt-screen.js`, `dist/keybindings.js`, `dist/tui.js`) and `@earendil-works/pi-coding-agent@1.0.0` (`dist/modes/interactive/interactive-mode.js`, `dist/core/extensions/runner.js`, `dist/modes/interactive/components/footer.js`):

- `TuiAltScreen`'s constructor registers `handleViewportInput` as the first input listener, so it runs before focused-component dispatch.
  It consumes `tui.altScreen.pageUp`/`pageDown`/`halfPage*`/`line*`/`previousPrompt`/`nextPrompt`/`top`/`bottom`.
  The defaults are `pageUp`, `pageDown`, `home`, `end`; `line*` and `halfPage*` are unbound.
- Those bindings are consumed **after** an early return: `if (this.shouldDeferViewportInputToOverlay()) return undefined`, which is true when `isOverlayFocused()`.
  A focused overlay therefore receives every one of them; `tui.altScreen.search` (Ctrl+Shift+F) is checked before the deferral and stays global.
- A wheel event is offered to `dispatchMouseToOverlay` first; a focused overlay whose component implements `handleMouse` handles it.
  `Container.handleMouse` forwards by row, so a docked component's `handleMouse` is reachable too.
- `TUI.mode` (`"regular" | "fullscreen"`) is public on the `TUI` interface, and `TuiMode`, `TuiMouseEvent`, `TuiMouseEventResult`, `OverlayOptions`, `KeyId`, `Keybinding`, `KeybindingsManager`, and `TUI_KEYBINDINGS` are all exported from `@earendil-works/pi-tui`.
- `ExtensionUIContext` has no mode accessor, and `showExtensionCustom` reads `options.overlay` **before** it calls the factory.
  In the non-overlay path, a factory that calls `done` synchronously triggers `close` → `restoreEditor` (re-adds the editor, which is still mounted, and restores its text) and resolves.
  The `.then` sees `closed` and never mounts the returned component.
  The same code is unchanged on Pi `main` (`packages/coding-agent/src/modes/interactive/interactive-mode.ts`).
- Non-interactive modes resolve `custom` to `undefined` without calling the factory (`runner.js` no-op UI, `rpc-mode.js`).
- Pi's footer renders 2 rows (cwd, stats), plus one row when any extension has set a status (`footer.js` `render`).
- `matchesKey` is exact on modifiers: Ctrl+PgUp (`\x1b[5;5~`) does not match `"pageUp"` (measured with a one-off node script against `pi-tui@1.0.0`).

## Design Overview

### Mount: probe the mode, then choose the path

```typescript
async handle(...) {
  // ...pick entry, build source (unchanged)...
  const mode = await probeTuiMode(ui);
  await ui.custom<undefined>(
    (tui, theme, keybindings, done) => new TranscriptPane({ tui, theme, keys: keybindings, source, heading, done, cwd, markdownTheme }),
    viewerMountOptions(mode),
  );
}
```

- `probeTuiMode(ui)` (private, below the handler): `ui.custom<TuiMode | undefined>((tui, _t, _k, done) => { done(tui.mode); return EMPTY_COMPONENT; })`.
  It returns `"fullscreen"` only when the probe resolves to exactly `"fullscreen"`; anything else, including `undefined` from a non-interactive UI, falls back to `"regular"` (the current, safe behavior).
  The probe passes no options, so it takes the non-overlay path in every mode.
- `viewerMountOptions(mode)` (private):
  - `regular` → `{ overlay: false }` (unchanged; ADR 0007).
  - `fullscreen` → `{ overlay: true, overlayOptions: FULLSCREEN_OVERLAY }`, where `FULLSCREEN_OVERLAY = { anchor: "bottom-center", width: "100%", maxHeight: "70%", margin: { bottom: 3 } }`.
- The pane keeps sizing itself (`VIEWPORT_HEIGHT_PCT = 70` of terminal rows, minus chrome), so `maxHeight: "70%"` is a safety bound, not the sizing rule.
- **Footer margin.**
  A 3-row bottom margin keeps Pi's default footer visible with or without an extension status row.
  With no status row, one blank row separates the pane from the footer.
  A taller custom footer (`setFooter`) is partly covered.
- `SessionNavigatorUI.custom`'s `options?: unknown` becomes `options?: ViewerMountOptions`, a local narrow type `{ overlay: boolean; overlayOptions?: OverlayOptions }` that Pi's `ExtensionUIContext.custom` options accept structurally.

### Keys: one narrow collaborator

```typescript
/** The `KeybindingsManager` surface the pane reads; Pi passes one to every `ui.custom` factory. */
export interface PaneKeys {
  matches(data: string, keybinding: Keybinding): boolean;
  getKeys(keybinding: Keybinding): KeyId[];
}
```

- `CustomComponentFactory`'s `keybindings: unknown` becomes `keybindings: PaneKeys`, and `TranscriptPaneOptions` gains `keys: PaneKeys` (7 → 8 fields; every one is read by the constructor).
- `handleInput` matches paging through `keys.matches(data, "tui.altScreen.pageUp" | "tui.altScreen.pageDown")` and top/bottom through `"tui.altScreen.top" | "tui.altScreen.bottom"`.
  Shift+↑/↓ stay hard-coded page aliases.
  The `tui.altScreen.*` ids are the viewport-scroll concept the pane implements, and the same bindings Pi uses for its own transcript, so an operator's remap applies to both.
  `tui.select.pageUp` (the issue's suggestion) names list selection and has no top/bottom pair.
- **Footer hint**, from a private `footerHint()`: `↑↓ scroll · <page> · <ends> · Esc close`.
  - `<page>` is the first key bound to `pageUp`, then `/`, then the first bound to `pageDown`.
  - `<ends>` is the same for `top`/`bottom`.
  - A pair with no keys on either side is omitted, and a pair with one side unbound shows the bound side alone.
  - Keys are capitalized per `+`-separated part, in Pi's `keyDisplayText` style.
  - The defaults render `↑↓ scroll · PageUp/PageDown · Home/End · Esc close` (estimated to fit an 80-column footer; Step 5 measures it).
  - The hint is the same in both modes, because in both modes those keys now reach the pane.

### Wheel

`handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined` handles `type === "wheel"` by scrolling `event.wheelDelta ?? 0` lines through the same clamp and auto-scroll rules as ↑/↓, and returns `{ handled: true }`.
Every other event type returns `undefined`.
Regular mode does not enable mouse tracking, so the method is inert there.

### Edge cases (each pinned in the named step)

- Probe resolves `undefined` → docked mount (Step 7).
- Probe resolves `"regular"` → `{ overlay: false }` exactly (Step 7; preserves the ADR 0007 test).
- A remapped `pageUp` pages on the new key and no longer on bare PgUp (Step 5).
- An unbound pair is omitted from the hint (Step 5).
- Wheel up then down returns to the bottom and re-enables auto-scroll (Step 6).
- A non-wheel mouse event is not handled (Step 6).

## Module-Level Changes

- `packages/pi-subagents/src/ui/session-navigator.ts`
  - Adds `PaneKeys`, `ViewerMountOptions`, the private helpers `probeTuiMode`, `viewerMountOptions`, `scrollBy`, `scrollTo`, and `footerHint`, the `FULLSCREEN_OVERLAY` constant, and `TranscriptPane.handleMouse`.
  - Changes `CustomComponentFactory`, `SessionNavigatorUI.custom`, `TranscriptPaneOptions`, and `SessionNavigatorHandler.handle`.
  - Updates the module doc comment's ADR 0007 paragraph to name the fullscreen exception and ADR 0012.
- `packages/pi-subagents/test/ui/session-navigator.test.ts`: characterization, keys, wheel, and mount tests; the handler suite's `makeUI` runs factories, and pane lookup goes through one helper.
- `packages/pi-subagents/test/helpers/transcript-fixtures.ts`: `mockTui` gains an optional `mode` (default `"regular"`); its other callers (`transcript-content.test.ts`, `transcript-fixtures.test.ts`) are unaffected.
- `packages/pi-subagents/docs/decisions/0012-fullscreen-viewer-is-an-overlay.md` (new): amends ADR 0007; records the probe, the overlay options, the footer margin, and the upstream posture ([earendil-works/pi#7574], [earendil-works/pi#7894]).
- `packages/pi-subagents/docs/decisions/0007-transcript-viewer-is-not-an-overlay.md`: frontmatter `status: amended by 0012` and a Status-section sentence, following ADR 0008's pattern.
- `packages/pi-subagents/README.md` `### /subagents:sessions`: the sample footer line and a sentence on fullscreen mode and the keybindings the keys follow.
- Predicted unchanged:
  - `src/index.ts` only constructs `SessionNavigatorHandler` and calls `handle`, whose params do not change (assessor confirmed at line ~273).
  - `docs/architecture/architecture.md` module tree (line ~424) names `session-navigator.ts` as the command handler; no module is added or moved.
  - `.pi/skills/package-pi-subagents/SKILL.md` names neither ADR 0007 nor the overlay mechanism (grepped).

## Test Impact Analysis

- **New tests the change enables:** key handling through an injected `KeybindingsManager` (remaps), a hint derived from bindings, wheel scrolling, and mode-dependent mount options.
  None was possible with hard-coded keys and a mount that ignored the factory's `tui`.
- **Existing tests that change:**
  - `footer rule › carries the scroll position…` asserts the literal hint; Step 5 updates it to the default-bindings rendering.
  - The handler suite's `toHaveBeenCalledOnce` assertions on `ui.custom` (two tests) and `renderCapturedPane`'s `calls[0]` read assume one `custom` call; Step 3 routes them through one helper, and Step 7 points that helper at the mount call.
- **Must stay as-is:** `mounts the transcript outside Pi's overlay compositor` pins ADR 0007 for regular mode; Step 7 keeps it (the fake UI's default mode is `regular`).
- No existing test covers PgUp/PgDn/Home/End; Step 1 adds characterization pins before anything moves.

## Invariants at risk

- **ADR 0007, regular mode never mounts an overlay** (constituency: regular-mode operators, whose scrollback [#733] protected).
  Pinned by `mounts the transcript outside Pi's overlay compositor`, plus Step 7's undefined-probe fallback test.
- **Scroll bounds computed at the rendered width** (`scroll bounds` describe).
  `scrollBy` and `handleMouse` must use `scrollBounds(this.inputWidth())`; Step 2 runs those tests unchanged.
- **Handler is a reactive consumer** (`record.getToolDefinition` not called; invariant #423 comment).
  Unchanged by the probe; the test stays.

## TDD Order

1. **test: pin the viewer's paging and top/bottom keys.**
   In `session-navigator.test.ts`, add `describe("paging keys")` on a pane with a transcript longer than its viewport (reuse the `height` suite's `rowsOf` fixture).
   Cover: PgUp (`\x1b[5~`) from the bottom moves up a full viewport, PgDn (`\x1b[6~`) returns to the bottom, Home shows the first row, End shows the last row and resumes following.
   Killing mutations:
   - Change the `pageUp` branch to subtract `1` instead of `viewportHeight`; the PgUp test goes red.
   - Delete the `home` branch; the Home test goes red.
   Commit: `test(pi-subagents): pin the session viewer's paging and top/bottom keys`.
2. **refactor: extract `scrollBy(delta)` and `scrollTo(offset)` on `TranscriptPane`.**
   Each owns the clamp and the `autoScroll = offset >= maxScroll` rule, using `scrollBounds(this.inputWidth())`.
   This prepares Steps 5 and 6, which would otherwise copy the clamp a sixth time.
   PgUp keeps `autoScroll = false`, so it goes through `scrollTo` with an explicit flag or an equivalent; it must not change behavior.
   Step 1's tests and the `scroll bounds` tests stay green unchanged.
   Commit: `refactor(pi-subagents): give the transcript pane one scroll clamp`.
3. **test: route the handler suite's pane lookup through one helper.**
   Add `mountedPaneFactory(ui)` returning the factory of the `ui.custom` call that mounts the pane (today `calls[0]`), and make `renderCapturedPane` use it.
   Replace the two `toHaveBeenCalledOnce` assertions on `ui.custom` with an assertion through the same helper that a pane was mounted.
   This prepares Step 7, where `custom` is called twice.
   Commit: `test(pi-subagents): find the mounted viewer through one helper`.
4. **refactor: extract `footerHint()` from `TranscriptPane.render`.**
   It still returns the literal; the `footer rule` tests stay green.
   Commit: `refactor(pi-subagents): name the viewer's footer hint`.
5. **feat: follow the operator's keybindings for paging and top/bottom.**
   - Add `PaneKeys`, `keys` in `TranscriptPaneOptions`, and `keybindings: PaneKeys` in `CustomComponentFactory`.
   - The handler passes the factory's `keybindings` through.
   - `makePane` defaults `keys` to `new KeybindingsManager(TUI_KEYBINDINGS)`, and `renderCapturedPane` passes one too.
   - `handleInput` matches through `keys`; `footerHint()` renders the resolved keys (Design Overview).
   - Update the `footer rule` assertion to `↑↓ scroll · PageUp/PageDown · Home/End · Esc close`, and confirm it still fits at 80 columns.
     If it does not, record the measured width and the shorter wording chosen.
   New tests:
   - A pane built with `{ "tui.altScreen.pageUp": "ctrl+b" }` pages up on Ctrl+B (`\x02`) and not on bare PgUp.
   - Its footer reads `Ctrl+B/PageDown`.
   - With `tui.altScreen.top` and `bottom` bound to `[]`, the footer has no `Home`/`End` segment.
   Step 1's tests stay green on default bindings.
   Killing mutations:
   - Restore `matchesKey(data, "pageUp")` in the page-up branch; the Ctrl+B test goes red.
   - Make `footerHint()` return the old literal; the remap hint test goes red.
   - Drop the empty-pair omission; the unbound test goes red.
   Commit: `feat(pi-subagents): the session viewer's paging keys follow your keybindings`.
6. **feat: scroll the viewer with the mouse wheel.**
   Add `handleMouse` (Design Overview).
   Tests:
   - A wheel event with `wheelDelta: -3` at the bottom shows the transcript 3 rows up.
   - A following `wheelDelta: 3` returns to the bottom, and a later source change keeps following.
   - A `click` event returns `undefined`.
   Killing mutations:
   - Use `Math.abs(event.wheelDelta)`; the scroll-up test goes red.
   - Return `{ handled: true }` for every event type; the click test goes red.
   Commit: `feat(pi-subagents): scroll the session viewer with the mouse wheel`.
7. **fix: page the session viewer natively in fullscreen mode.**
   - Add `probeTuiMode`, `viewerMountOptions`, `FULLSCREEN_OVERLAY`, and `ViewerMountOptions`.
   - Update the module doc comment.
   - In tests, `mockTui` gains an optional `mode`.
   - The handler suite's `makeUI({ mode })` implements `custom` by invoking each factory with `mockTui(…, mode)` and a real `KeybindingsManager`.
     It resolves with the `done` value when `done` is called synchronously, and with `undefined` otherwise.
     `mountedPaneFactory` now picks the last call.
   - Add `makeUI({ probeResult: undefined })`, which simulates a non-interactive UI by resolving without calling the factory.
   New tests (`describe("mount mode")`):
   - Fullscreen mounts with exactly `{ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "70%", margin: { bottom: 3 } } }`.
   - Regular keeps exactly `{ overlay: false }` (the existing ADR 0007 test).
   - A probe that resolves `undefined` mounts with `{ overlay: false }`.
   - The probe's factory calls `done` before returning, so the probe never mounts a component.
   Killing mutations:
   - Make `viewerMountOptions` return `{ overlay: false }` unconditionally; the fullscreen test goes red.
   - Make the fallback treat a non-`"regular"` result as fullscreen (`mode === "regular" ? "regular" : "fullscreen"`); the undefined-probe test goes red.
   - Change `margin: { bottom: 3 }` to `3`; the fullscreen exact-options test goes red.
   Commit: `fix(pi-subagents): page the session viewer natively in fullscreen mode`.
8. **docs: record the fullscreen overlay decision.**
   - Add ADR 0012, amending ADR 0007.
     - Context: the alt-screen listener, the upstream posture, why the 0007 defect is regular-mode only (0007's own text on `TuiAltScreen`).
     - Decision: probe, options, the 3-row margin.
     - Consequences: the probe's extra `ui_prompt_start`/`ui_prompt_end` pair, a covered custom footer, no parent wheel while open.
   - Update ADR 0007's frontmatter and Status section.
   - Update the README `### /subagents:sessions` sample footer and add a sentence on fullscreen behavior and the bindings.
   - Then run the manual check in Risks and record its result in the retro.
   Commit: `docs(pi-subagents): record why the fullscreen session viewer is an overlay`.

## Risks and Mitigations

- **The probe relies on `done` before the factory returns being a no-op.**
  This was verified in `interactive-mode.js` (1.0.0) and on Pi `main`.
  If a future Pi mounts first, the probe's empty component would flash for one frame and then close.
  The upstream-assumption table is not updated (it tracks lifecycle seams, not UI), but ADR 0012 names the dependency and the file.
- **The probe emits an extra `ui_prompt_start`/`ui_prompt_end` pair** (`runner.js` `withUIPrompt`).
  `pi-permission-system` consumes `ui_prompt` events; `select` and the viewer's own `custom` already emit pairs, so one more short pair is within what listeners already see.
- **The probe re-sets the editor's text** (`restoreEditor` → `setText(savedText)`), which can move the cursor to the end of a draft.
  `ui.select` immediately before it already does the same.
- **A custom footer taller than 3 rows is partly covered** in fullscreen.
  This was accepted at the planning gate and is documented in ADR 0012.
- **The wheel over the parent area does not scroll the parent** while the fullscreen viewer has focus: the focused overlay is deferred the raw wheel bytes, which the pane ignores.
  This is consistent with a modal viewer; Esc closes it.
- **Unverified live:** the overlay's on-screen placement and wheel routing were read from the compiled source, not observed.
  Step 8 includes a manual check in fullscreen and regular mode against a long subagent transcript:
  - PgUp/PgDn/Home/End/wheel move the pane;
  - Pi's footer stays visible;
  - regular mode is unchanged;
  - no chrome lands in regular-mode scrollback.

## Open Questions

- Should the fullscreen cap drop below 70% if the floating pane feels taller than the docked one did?
  It is one constant; revisit after use.

[#733]: https://github.com/gotgenes/pi-packages/issues/733
[#874]: https://github.com/gotgenes/pi-packages/issues/874
[earendil-works/pi#7574]: https://github.com/earendil-works/pi/issues/7574
[earendil-works/pi#7894]: https://github.com/earendil-works/pi/issues/7894
