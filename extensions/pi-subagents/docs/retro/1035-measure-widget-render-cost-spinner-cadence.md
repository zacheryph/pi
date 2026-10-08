---
issue: 1035
issue_title: "pi-subagents: measure the agents widget's render cost to settle its spinner cadence"
pr: 1024
---

# Retro: #1035 — measure the agents widget's render cost to settle its spinner cadence

## Stage: PR Review (2026-10-06T04:50:52Z)

### Session summary

PR #1024 by @ReStranger changes `WIDGET_UPDATE_INTERVAL_MS` from 250 ms back to 80 ms, on the premise that Pi's fullscreen default (since Pi 1.0.0) redraws only visible lines.
The underlying want — a spinner as smooth as Pi's own `Loader` — is real but cosmetic, and the PR's premise holds for terminal output only, not for the render pass the 250 ms value guards.
The operator chose to plan our own design: filed #1035 to measure the real per-frame cost before picking a cadence.

### Evaluation

Verify gate (against `main` at `551c0e8f`):

- Fullscreen default confirmed: Pi commit `88ff80b98` (`feat(coding-agent): make fullscreen the default TUI mode`), listed under `[1.0.0]` in Pi's `CHANGELOG.md`; our peer floor is `>=1.0.0`.
- The 250 ms rationale is **render cost**, not #864: `2eb62924` (`perf(pi-subagents): slow the agents widget animation to 250 ms`) cites 12.5 whole-tree walks per second while the parent idles. #864's destructive repaint was fixed by the height budget (`DOCK_LINES_BELOW_WIDGET` in `src/ui/widget-renderer.ts`).
  The PR's new doc comment ("250 ms was Issue #864's answer") misattributes it.
- Fullscreen does not remove the walk: `TuiAltScreen.doRender` calls `renderLayoutFrame` with a fresh per-frame `renderCache`, and Pi's transcript is `ScrollView(documentContainer)` (`chat-viewport.ts`), laid out at unbounded height.
  Probe (synthetic input, upstream function called directly): installed `@earendil-works/pi-tui` 1.0.0 `dist/layout.js` `renderLayoutFrame`, a `ScrollView` over 500 counting components at 120×40 → 1000 component `render` calls per frame, n=3 frames, 40 visible lines.
  Per-frame CPU cost on a real transcript is **unmeasured** — message components may cache internally — and the 2026-09 commit's cost claim was likewise a count, not a timing.

Checks run on the PR head `ed038e99` in a scratch worktree: `pnpm run check` pass, `pnpm run lint` pass, pi-subagents vitest 1962/1962 pass; PR CI `check` green.

Design: the diff is already minimal (one constant, a tightened cadence test, doc mirrors).
Nothing is over-built; what is wrong is the justification, and the comment would rewrite why 250 ms exists.
The `regular` TUI mode is still supported (`tuiMode: "regular"`), where the whole-tree walk is the same.

### Decision and attribution

Direction: adopt the capability with our own design — #1035 measures per-frame render cost of a real long transcript at 80 ms vs 250 ms (fullscreen and regular) while the parent idles, then sets the cadence the measurement supports (80 ms, an intermediate, or 250 ms with recorded reasoning).
Non-goals: no new setting for the cadence; no change to the height budget.
Any comment written must attribute 250 ms to render cost, not #864.

Attribution: if the cadence changes, the implementing commit carries

```text
Co-authored-by: ReStranger <restranger@disroot.org>
```

and the PR #1024 close comment thanks @ReStranger and links the implementing SHA (or the measurement, if 250 ms stays).
Reference the PR as `Refs #1024`, never `Closes #1024`.
