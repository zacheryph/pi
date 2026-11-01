---
status: accepted (personal fork)
date: 2026-10-08
---

# 0013 — A passive, fullscreen-only subagent watch overlay

## Context

The compact widget identifies agents but cannot show their output. Operators want
an optional right-side spectator view with stacked agent headers, live assistant
text, and brief tool summaries. Agents must remain in-process; no cmux dependency,
separate execution process, scrolling, or session takeover is needed.

Pi supports passive overlays but does not expose a docked sidebar slot that
reflows the parent transcript. An overlay therefore covers parent content.

The regular-mode scrollback defect in [ADR 0007](0007-transcript-viewer-is-not-an-overlay.md)
still reproduces on installed pi-tui 1.1.0. A 24-row terminal, an 18-row top-right
panel, and thirty ten-line parent appends produced 276 contaminated committed
rows with no top margin, 248 with one row, and 220 with two rows. The no-overlay
control produced zero. Margins help small updates, not bursts: previously covered
rows can still move into scrollback before a repair frame reaches them.

## Decision

- Mount only in Pi fullscreen mode, consistent with [ADR 0012](0012-fullscreen-viewer-is-an-overlay.md).
  Regular mode keeps its existing widget and transcript viewer; toggle requests
  report that fullscreen is required.
- Start closed. `overlayDefaultOpen` controls automatic opening before an explicit
  choice; the last explicit show/hide wins for the current session, including
  later agent runs. Automatic idle hiding and renderer mode changes do not
  overwrite that preference. Session replacement/reload resets it.
- Use width presets `quarter`, `third` (default), `half`, and `two-thirds`, exposed
  in `/subagents:settings` and the normal layered settings file.
- `Ctrl+Alt+S` and `/subagents:watch` toggle visibility. A non-capturing overlay
  keeps parent editor focus and does not handle input or stop agents.
- Stack bounded always-tailing sections. Show assistant text, one-line tool
  arguments/results, retries, and compaction activity; omit inherited history,
  thinking, images, and full tool payloads. Repaint requests are coalesced to
  100 ms. Finished sections linger eight seconds; overflow prioritizes running,
  then queued, then finished agents.
- Reserve six bottom rows for Pi's dock and suppress the panel on tiny terminals.
- Wire an optional internal session-ready observer before the first child prompt,
  preserving per-spawn observers. Do not widen the public snapshot/service API.

## Ownership and cleanup

A zero-row widget obtains Pi's injected TUI. The controller owns a low-level
`showOverlay()` handle, rather than an unresolved `ui.custom()` interaction.
Its `hide()` removes that specific overlay even when another extension's overlay
is above it. `setHidden()` handles ordinary toggles. The parent editor is never
replaced and no second terminal renderer is created.

Buffers remain plain text and bounded; colors are applied during rendering from
the current theme. Session replacement/shutdown removes subscriptions, timers,
and the owned overlay. Hidden panels still capture bounded activity so reopening
shows current tails without replaying inherited conversation.

The full `/subagents:sessions` viewer remains unchanged.
