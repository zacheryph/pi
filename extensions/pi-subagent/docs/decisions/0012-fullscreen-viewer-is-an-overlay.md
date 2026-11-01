---
status: accepted
date: 2026-10-06
---

# 0012 — In fullscreen mode the transcript viewer is an overlay

## Status

Accepted.
Amends [ADR 0007], which stands for regular mode: there the viewer is still a docked pane and never an overlay.
This record carves out fullscreen mode, where ADR 0007's defect cannot occur and the docked mount has a defect of its own.

## Context

In fullscreen mode (Pi's default `tuiMode`), the `/subagents:sessions` viewer advertised `PgUp/PgDn`, but those keys scrolled the parent conversation and left the transcript where it was ([#1032]).
Home and End did the same.

### The mechanism

Verified against the compiled `@earendil-works/pi-tui` 1.0.0 (`dist/tui-alt-screen.js`):

- `TuiAltScreen`'s constructor registers `handleViewportInput` as its first input listener, so it runs before any focused component receives input.
  An extension cannot get ahead of it: `ctx.ui.onTerminalInput` and `addInputListener` append to the same insertion-ordered set.
- It consumes the `tui.altScreen.*` viewport bindings: `pageUp`/`pageDown`/`top`/`bottom` default to PgUp, PgDn, Home, and End.
- Before it checks them, it returns early when `shouldDeferViewportInputToOverlay()` holds, which is when a visible overlay has focus.
  Wheel events are offered to the focused overlay first, too.

A docked component is focused but is not an overlay, so it never sees those keys.

### Upstream

This is upstream's design, not an oversight.
[earendil-works/pi#7574] reported the same shadowing for the editor and was closed with the rule that in fullscreen the unmodified keys apply to the transcript, and the `Ctrl+` variants to the editor.
[earendil-works/pi#7894] then added the focused-overlay deferral.
Asking upstream to let a focused non-overlay component claim the keys would argue against a decision already made.

### Why ADR 0007 does not apply

ADR 0007's defect is regular-mode only: `TuiMainScreen` composites overlays into the buffer that backs scrollback.
Its own text records that `TuiAltScreen` composites into a bounded screen buffer with no scrollback behind it.

## Decision

In fullscreen mode, mount the viewer with `ui.custom`'s overlay path: anchored `bottom-center`, full width, `maxHeight` 70% (the pane still sizes itself to its content under the same cap), and a 2-row bottom margin.
In regular mode, keep `{ overlay: false }`.

### Detecting the mode

`TUI.mode` (`"regular" | "fullscreen"`) is public, but `ExtensionUIContext` has no mode accessor, and Pi's `showExtensionCustom` reads `options.overlay` before it runs the factory.
The handler therefore probes first: a `ui.custom` call whose factory calls `done(tui.mode)` and returns an empty component.
In the non-overlay path a `done` called before the factory returns restores the editor (which is still mounted) and resolves, and Pi never mounts the returned component (`dist/modes/interactive/interactive-mode.js` in `pi-coding-agent` 1.0.0, unchanged on Pi `main`).
A UI that runs no factory (print and RPC modes) resolves `undefined`, which keeps the docked default.

Reading the `tuiMode` setting instead was rejected: it misses the `--tui-mode` CLI flag.

### The footer margin

The docked pane replaces only the editor, so Pi's footer stays visible below it.
An overlay is positioned from the screen edges and would cover the footer, whose height Pi does not expose.
Pi's default footer renders two rows (working directory, stats), plus one when any extension has set a status.
The margin reserves exactly the two default rows.
A 3-row margin was tried first and rejected in live use: the editor stays mounted under the overlay, so with no status row the extra row showed the editor's bottom border directly under the pane's own footer rule.

### Keys

The viewer's paging and top/bottom keys match the same `tui.altScreen.*` bindings through the `KeybindingsManager` Pi passes to the factory, so a remap applies to the transcript and the viewer alike.
Its footer names the keys actually bound.
The wheel reaches it through `Component.handleMouse`.

## Consequences

- In fullscreen, PgUp/PgDn, Home/End, and the wheel over the pane move the transcript, as they do in regular mode.
- The viewer floats over the region it filled when docked; the parent conversation stays visible above it.
- The probe emits one extra `ui_prompt_start`/`ui_prompt_end` pair, and re-sets the editor's text as `ui.select` before it already does.
- The probe depends on `done` before the factory returns being a no-op in `showExtensionCustom`.
  If Pi ever mounts first, the empty component would show for one frame and close.
- The pane sits flush on Pi's default footer.
  An extension status row, and any custom footer taller than two rows (`setFooter`), is covered while the viewer is open.
- While the fullscreen viewer has focus, the wheel over the parent does not scroll the parent: Pi defers the event to the focused overlay, which ignores it.
  Esc closes the viewer.

[ADR 0007]: 0007-transcript-viewer-is-not-an-overlay.md
[#1032]: https://github.com/gotgenes/pi-packages/issues/1032
[earendil-works/pi#7574]: https://github.com/earendil-works/pi/issues/7574
[earendil-works/pi#7894]: https://github.com/earendil-works/pi/issues/7894
