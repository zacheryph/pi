# Changelog

Changes recorded automatically from Git history, newest first.

<!-- changelog:through 802542b1d6d6e98c0a0d3978bdfa41a8787a0f61 -->

- 2026-11-15: feat\(pi-todo\): bold the task key and count active and pending tasks ([#183](https://github.com/zacheryph/pi/pull/183))
- 2026-11-15: feat\(pi-todo\): mark the widget's status glyphs with their state ([#182](https://github.com/zacheryph/pi/pull/182))
- 2026-11-15: feat\(pi-todo\): archive old completed tasks instead of a 50-task cap ([#175](https://github.com/zacheryph/pi/pull/175))
- 2026-11-14: feat\(pi-todo\): write todo changes into the transcript instead of a per-request card ([#174](https://github.com/zacheryph/pi/pull/174))
- 2026-11-13: feat\(pi-todo\): offer the widget and /todo browser as views and actions ([#172](https://github.com/zacheryph/pi/pull/172))
- 2026-11-13: feat\(pi-todo\): /todo and its commands answer without a terminal ([#171](https://github.com/zacheryph/pi/pull/171))
- 2026-11-12: refactor: centralize workspace configs and development commands ([#153](https://github.com/zacheryph/pi/pull/153))
- 2026-11-12: refactor: standardize workspace aliases and shared test helpers ([#149](https://github.com/zacheryph/pi/pull/149))
- 2026-11-12: fix\(pi-todo\): keep an agent's task claim across a reload or restart ([#151](https://github.com/zacheryph/pi/pull/151))
- 2026-11-12: refactor\(pi-foundations\): consolidate plain-data helpers ([#147](https://github.com/zacheryph/pi/pull/147))
- 2026-11-12: refactor\(pi-ui\): centralize non-TUI modal fallbacks ([#146](https://github.com/zacheryph/pi/pull/146))
- 2026-11-12: refactor: declare stash, git, todo, dashboard and tldr settings with defineSettings ([#144](https://github.com/zacheryph/pi/pull/144))
- 2026-11-12: refactor: let contextCard own whether the card is shown ([#142](https://github.com/zacheryph/pi/pull/142))
- 2026-11-12: refactor: extract shared session-state plumbing into pi-session-state ([#142](https://github.com/zacheryph/pi/pull/142))
- 2026-11-11: refactor\(pi-todo\): replay only the todo journal ([#141](https://github.com/zacheryph/pi/pull/141))
- 2026-11-11: fix\(pi-todo\): reserve delegated task acceptance for the parent ([#124](https://github.com/zacheryph/pi/pull/124))
- 2026-11-10: Replace steer and resume with subagent\_send ([#121](https://github.com/zacheryph/pi/pull/121))
- 2026-11-08: test: add fauxSession and build SDK tests on it ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test: add fakeCustomUi and mount ui.custom components with it ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test\(pi-todo\): share one harness between index and delegation tests ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test\(pi-todo\): render the inline widget with plainTheme ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test: add helpers for Symbol-keyed globals and the session tree ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test: add plain and ANSI test themes and replace inline theme stubs ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test: add settingsDirs for layered config fixtures ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test: add pi-test-helpers with tempDir and use it for test temp directories ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-06: fix\(pi-todo\): supply tools for restricted-agent handoffs ([#102](https://github.com/zacheryph/pi/pull/102))
- 2026-11-04: fix\(pi-todo\): stop expanded tool results from repeating the widget ([#76](https://github.com/zacheryph/pi/pull/76))
- 2026-11-02: docs\(vendor\): keep UPSTREAM.md to vendoring details and log local changes in CHANGELOG.md ([#65](https://github.com/zacheryph/pi/pull/65))
- 2026-11-01: fix\(pi-ui\): stop the inline window flickering on short scrolls and collapse docked widgets while it is open ([#64](https://github.com/zacheryph/pi/pull/64))
- 2026-11-01: refactor\(pi-subagent\): rename pi-subagents and pi-subagents-worktrees, and scope their identifiers ([#59](https://github.com/zacheryph/pi/pull/59))
- 2026-11-01: refactor\(pi-todo\): one tool per action and resource-scoped identifiers ([#57](https://github.com/zacheryph/pi/pull/57))
- 2026-11-01: refactor\(pi-todo\): render widget and browser with shared pi-ui ([#50](https://github.com/zacheryph/pi/pull/50))
- 2026-11-01: refactor: share settings and model lookup in pi-foundations ([#44](https://github.com/zacheryph/pi/pull/44))
- 2026-10-31: chore: adopt Oxc and TypeScript 7 across all workspaces ([#42](https://github.com/zacheryph/pi/pull/42))
- 2026-10-31: feat\(pi-todo\): hand tasks to subagents that update them in the parent's list ([#40](https://github.com/zacheryph/pi/pull/40))
- 2026-10-30: feat: publish todo and stash snapshots on pi.events; show counts on dashboard cards ([#23](https://github.com/zacheryph/pi/pull/23))
- 2026-10-29: chore: share stricter compiler settings and drop redundant vitest aliases ([#17](https://github.com/zacheryph/pi/pull/17))
- 2026-10-29: chore\(deps\): align dev dependencies with Pi and Node 24, upgrade Vitest 5 ([#15](https://github.com/zacheryph/pi/pull/15))
- 2026-10-29: feat\(pi-jobs\): vendor woksin/pi-jobs, pin Pi 1.4.0, and add a vendor-extension skill ([#12](https://github.com/zacheryph/pi/pull/12))
- 2026-10-29: feat\(pi-todo\): task messages, update history, and review tracking ([#7](https://github.com/zacheryph/pi/pull/7))
- 2026-10-08: Close todo progress header with trailing border ([94b3cd3](https://github.com/zacheryph/pi/commit/94b3cd323a127a2f7be67e3e8f0c6da177164508))
- 2026-10-08: Add spaced Nerd Font icons to subagent and todo titles ([fb5a26a](https://github.com/zacheryph/pi/commit/fb5a26a51f025779cbd12392e1cb99b786edcbaf))
- 2026-10-08: Add dependency-aware todo planner with subagent-style UX ([#1](https://github.com/zacheryph/pi/pull/1))

## Initial import

- Source: [`99percentpeople/pi-extensions`](https://github.com/99percentpeople/pi-extensions),
  directory `extensions/todo`.
- Pinned revision: `a7ae6b89a211c35b657e886e9ceeafbf51616c22`.
- Version: `@99percentpeople/pi-todo` 1.2.8.
- Imported: 2026-10-08.
- License: MIT; Zach Yuen's original copyright and permission notice remain in
  [LICENSE](LICENSE).

Sparse-cloned the pinned source into a temporary checkout, extracted the todo
state engine and license, then removed the checkout. `src/state.ts` was copied
byte-for-byte from `extensions/todo/state.ts` at that revision. The original
extension entry point, settings, and UI were not imported. This is editable
source, not a submodule or nested Git repository. Preserve the engine's pure
validation/replay API when updating it.
