# Changelog

Changes recorded automatically from Git history, newest first.

<!-- changelog:through 6ba5f77b02f5787c9c080d78f6a2b02da99b7ee4 -->

- 2026-11-14: fix\(cards\): write restore cards into the transcript once after compaction ([#173](https://github.com/zacheryph/pi/pull/173))
- 2026-11-13: feat\(pi-subagent\): offer agents as models, agent/&lt;name\> ([#169](https://github.com/zacheryph/pi/pull/169))
- 2026-11-13: feat\(pi-subagent\): choose the main agent from PI\_MAIN\_AGENT ([#168](https://github.com/zacheryph/pi/pull/168))
- 2026-11-13: feat\(pi-subagent\): commands answer without a terminal ([#171](https://github.com/zacheryph/pi/pull/171))
- 2026-11-12: feat\(skills\): deliver a roadmap as pull requests through merge and deploy ([#165](https://github.com/zacheryph/pi/pull/165))
- 2026-11-12: feat\(pi-subagent\): reserve the orchestrator's work tools for its workers ([#164](https://github.com/zacheryph/pi/pull/164))
- 2026-11-12: refactor: centralize workspace configs and development commands ([#153](https://github.com/zacheryph/pi/pull/153))
- 2026-11-12: refactor: standardize workspace aliases and shared test helpers ([#149](https://github.com/zacheryph/pi/pull/149))
- 2026-11-12: fix\(pi-todo\): keep an agent's task claim across a reload or restart ([#151](https://github.com/zacheryph/pi/pull/151))
- 2026-11-12: refactor\(pi-subagent\): declare settings with defineSettings ([#148](https://github.com/zacheryph/pi/pull/148))
- 2026-11-12: refactor\(pi-foundations\): consolidate plain-data helpers ([#147](https://github.com/zacheryph/pi/pull/147))
- 2026-11-12: refactor\(pi-ui\): centralize non-TUI modal fallbacks ([#146](https://github.com/zacheryph/pi/pull/146))
- 2026-11-12: refactor\(pi-dashboard\): consume producer snapshot contracts ([#145](https://github.com/zacheryph/pi/pull/145))
- 2026-11-12: refactor: let contextCard own whether the card is shown ([#142](https://github.com/zacheryph/pi/pull/142))
- 2026-11-12: refactor: extract shared session-state plumbing into pi-session-state ([#142](https://github.com/zacheryph/pi/pull/142))
- 2026-11-11: refactor\(pi-subagent\): drop compatibility with older records and settings ([#141](https://github.com/zacheryph/pi/pull/141))
- 2026-11-11: refactor\(pi-job\): drop the completion dedupe for older transcripts ([#141](https://github.com/zacheryph/pi/pull/141))
- 2026-11-11: feat: publish authoritative subagent snapshots for dashboard recovery ([#125](https://github.com/zacheryph/pi/pull/125))
- 2026-11-11: test: align harness fixtures with implement and parent acceptance ([#124](https://github.com/zacheryph/pi/pull/124))
- 2026-11-11: fix\(pi-todo\): reserve delegated task acceptance for the parent ([#124](https://github.com/zacheryph/pi/pull/124))
- 2026-11-11: feat\(pi-subagent\): add implement profile and align worker lifecycle guidance ([#124](https://github.com/zacheryph/pi/pull/124))
- 2026-11-10: Keep idle agents across parent reload and restart ([#121](https://github.com/zacheryph/pi/pull/121))
- 2026-11-10: Release a session only for an agent that is done ([#121](https://github.com/zacheryph/pi/pull/121))
- 2026-11-10: Route a child's ask through the work contract ([#121](https://github.com/zacheryph/pi/pull/121))
- 2026-11-10: Deliver work messages into a running managed child ([#121](https://github.com/zacheryph/pi/pull/121))
- 2026-11-10: Provide a managed work host for each child ([#121](https://github.com/zacheryph/pi/pull/121))
- 2026-11-10: Make pi-subagent a work producer for its spawner ([#121](https://github.com/zacheryph/pi/pull/121))
- 2026-11-10: Replace steer and resume with subagent\_send ([#121](https://github.com/zacheryph/pi/pull/121))
- 2026-11-10: Move agents to the idle state model ([#121](https://github.com/zacheryph/pi/pull/121))
- 2026-11-10: Drop foreground and every blocking read ([#121](https://github.com/zacheryph/pi/pull/121))
- 2026-11-09: Give Subagent one run abstraction ([#109](https://github.com/zacheryph/pi/pull/109))
- 2026-11-09: Pin today's parent-visible subagent behaviour ([#107](https://github.com/zacheryph/pi/pull/107))
- 2026-11-09: chore: update Pi to 1.5.0 ([c78186c](https://github.com/zacheryph/pi/commit/c78186c20776d4dbb00893cf3118132c3b874197))
- 2026-11-08: test\(pi-subagent\): share the makeAgentConfig test builder ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test\(pi-subagent\): one fixture for real child sessions in SDK tests ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test: add fauxSession and build SDK tests on it ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test: add fakeCustomUi and mount ui.custom components with it ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test\(pi-subagent\): one fake pi for tests that load the whole extension ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test: add fakePi and build extension index harnesses on it ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test: add helpers for Symbol-keyed globals and the session tree ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test: add markupTheme for assertions on styling ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test: add plain and ANSI test themes and replace inline theme stubs ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test: add shared wait helpers and replace inline timer promises ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test: add settingsDirs for layered config fixtures ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-08: test: add pi-test-helpers with tempDir and use it for test temp directories ([#104](https://github.com/zacheryph/pi/pull/104))
- 2026-11-06: fix\(pi-todo\): supply tools for restricted-agent handoffs ([#102](https://github.com/zacheryph/pi/pull/102))
- 2026-11-05: refactor\(pi-subagent\): lowercase agent names and drop twin labels ([#94](https://github.com/zacheryph/pi/pull/94))
- 2026-11-05: refactor\(pi-subagent\): fold duplicated turn-loop, settings and test code ([#92](https://github.com/zacheryph/pi/pull/92))
- 2026-11-05: refactor\(pi-subagent\): remove members nothing reads ([#92](https://github.com/zacheryph/pi/pull/92))
- 2026-11-05: test\(pi-subagent\): drop the tests of test helpers ([#92](https://github.com/zacheryph/pi/pull/92))
- 2026-11-05: refactor\(pi-subagent\): remove the typed service API and workspace-provider seam ([#92](https://github.com/zacheryph/pi/pull/92))
- 2026-11-05: docs\(pi-subagent\): drop upstream's plans, retros and phase histories ([#92](https://github.com/zacheryph/pi/pull/92))
- 2026-11-05: fix\(subagent\): reject invalid definitions when queued agents start ([#88](https://github.com/zacheryph/pi/pull/88))
- 2026-11-05: feat\(pi-subagent\): opt a profile into delegation with delegate: true ([#88](https://github.com/zacheryph/pi/pull/88))
- 2026-11-05: fix\(pi-subagent\): keep one malformed agent file from breaking every spawn ([#88](https://github.com/zacheryph/pi/pull/88))
- 2026-11-05: feat\(pi-subagent\): default agent files to prompt\_mode replace ([#88](https://github.com/zacheryph/pi/pull/88))
- 2026-11-05: feat\(pi-subagent\): add the creating-agents skill ([#88](https://github.com/zacheryph/pi/pull/88))
- 2026-11-05: refactor\(pi-subagent\): define the built-in agents as markdown files ([#88](https://github.com/zacheryph/pi/pull/88))
- 2026-11-05: feat\(pi-subagent\): list every agent type on one dense line with its guidance ([#88](https://github.com/zacheryph/pi/pull/88))
- 2026-11-05: feat\(pi-subagent\): replace enabled with a visibility field ([#88](https://github.com/zacheryph/pi/pull/88))
- 2026-11-05: refactor\(pi-subagent\): let the caller alone decide foreground or background ([#88](https://github.com/zacheryph/pi/pull/88))
- 2026-11-05: fix\(pi-subagent\): register the agent definitions browser as /subagent:agents ([#87](https://github.com/zacheryph/pi/pull/87))
- 2026-11-05: fix\(pi-subagent\): restore the agent definitions browser as /agents ([#87](https://github.com/zacheryph/pi/pull/87))
- 2026-11-04: feat\(pi-subagent\): add four-fifths overlay width preset ([#86](https://github.com/zacheryph/pi/pull/86))
- 2026-11-04: fix\(pi-subagent\): serialize cold resumes and retain resolved turn limits ([#85](https://github.com/zacheryph/pi/pull/85))
- 2026-11-04: feat\(pi-subagent\): cold resume a released subagent from its saved transcript ([#85](https://github.com/zacheryph/pi/pull/85))
- 2026-11-04: fix\(pi-subagent\): keep lifecycle writes branch-aware and persist session metadata ([#84](https://github.com/zacheryph/pi/pull/84))
- 2026-11-04: feat\(pi-subagent\): record the whole agent lifecycle, answer subagent\_get from it, and restore a roster card ([#84](https://github.com/zacheryph/pi/pull/84))
- 2026-11-04: feat\(pi-subagent\): run agents in the background by default with a foreground flag ([#75](https://github.com/zacheryph/pi/pull/75))
- 2026-11-04: feat\(pi-git\): read fresh PR status with git\_pr\_status and /git:refresh ([#72](https://github.com/zacheryph/pi/pull/72))
- 2026-11-04: feat\(orchestrator, execute-roadmap\): run implementation work in pi-git worktrees ([#71](https://github.com/zacheryph/pi/pull/71))
- 2026-11-03: chore: remove pi-subagent-worktree from the bundle ([#68](https://github.com/zacheryph/pi/pull/68))
- 2026-11-03: feat\(pi-subagent\): let the caller choose a subagent's working directory ([#66](https://github.com/zacheryph/pi/pull/66))
- 2026-11-02: docs\(vendor\): keep UPSTREAM.md to vendoring details and log local changes in CHANGELOG.md ([#65](https://github.com/zacheryph/pi/pull/65))
- 2026-11-01: fix\(pi-ui\): stop the inline window flickering on short scrolls and collapse docked widgets while it is open ([#64](https://github.com/zacheryph/pi/pull/64))
- 2026-11-01: feat\(pi-ask\): one ask tool routed to the parent agent or the user, with a pi-ui inline window ([#62](https://github.com/zacheryph/pi/pull/62))
- 2026-11-01: refactor\(pi-subagent\): rename pi-subagents and pi-subagents-worktrees, and scope their identifiers ([#59](https://github.com/zacheryph/pi/pull/59))
- 2026-11-01: refactor\(pi-todo\): one tool per action and resource-scoped identifiers ([#57](https://github.com/zacheryph/pi/pull/57))
- 2026-11-01: refactor\(pi-subagents\): use shared pi-ui for browser, widget and primitives ([#51](https://github.com/zacheryph/pi/pull/51))
- 2026-11-01: refactor: share settings and model lookup in pi-foundations ([#44](https://github.com/zacheryph/pi/pull/44))
- 2026-11-01: chore: remove standalone declaration bundling ([#43](https://github.com/zacheryph/pi/pull/43))
- 2026-10-31: chore: adopt Oxc and TypeScript 7 across all workspaces ([#42](https://github.com/zacheryph/pi/pull/42))
- 2026-10-31: feat\(pi-todo\): hand tasks to subagents that update them in the parent's list ([#40](https://github.com/zacheryph/pi/pull/40))
- 2026-10-31: feat\(pi-subagents\): forward a generic spawn handoff and run identity on child events ([#35](https://github.com/zacheryph/pi/pull/35))
- 2026-10-31: feat\(pi-subagents-worktrees\): vendor git worktree isolation for subagents ([#33](https://github.com/zacheryph/pi/pull/33))
- 2026-10-31: feat\(pi-subagents\): add a reviewer profile and gate orchestrator completion on it ([#36](https://github.com/zacheryph/pi/pull/36))
- 2026-10-31: feat\(pi-subagents\): default Explore to the newest available Haiku ([#38](https://github.com/zacheryph/pi/pull/38))
- 2026-10-31: fix\(pi-subagents\): keep the parent's service published while children run ([#29](https://github.com/zacheryph/pi/pull/29))
- 2026-10-30: feat\(pi-stash\): handle-based working-set store ([#13](https://github.com/zacheryph/pi/pull/13))
- 2026-10-29: chore: share stricter compiler settings and drop redundant vitest aliases ([#17](https://github.com/zacheryph/pi/pull/17))
- 2026-10-29: chore\(deps\): align dev dependencies with Pi and Node 24, upgrade Vitest 5 ([#15](https://github.com/zacheryph/pi/pull/15))
- 2026-10-29: feat\(pi-jobs\): vendor woksin/pi-jobs, pin Pi 1.4.0, and add a vendor-extension skill ([#12](https://github.com/zacheryph/pi/pull/12))
- 2026-10-22: feat\(subagents\): add todo-driven orchestrator profile ([#8](https://github.com/zacheryph/pi/pull/8))
- 2026-10-15: feat\(pi-subagents\): show queued agents as a title-bar count instead of rows ([2cd531f](https://github.com/zacheryph/pi/commit/2cd531f195be2a4d08d7c28f5a7b0b500b8719cc))
- 2026-10-14: fix\(pi-subagents\): sort agents browser alphabetically ([c64141a](https://github.com/zacheryph/pi/commit/c64141a281fbbcf1acfd5adb7c91d2fc4f0e7209))
- 2026-10-14: feat\(pi-subagents\): default to all tools with selective exclusions ([#2](https://github.com/zacheryph/pi/pull/2))
- 2026-10-09: pi-subagents: tolerate empty MCP wildcard matches at startup ([6c08a94](https://github.com/zacheryph/pi/commit/6c08a94955c53cb521a54931bac0a5a3a3e7a994))
- 2026-10-09: pi-subagents: add explicit main profile model override ([57c8f66](https://github.com/zacheryph/pi/commit/57c8f665604b3d0425d7edadb02291133a4c7651))
- 2026-10-09: pi-subagents: compose named prompt fragments for agent profiles ([ea70017](https://github.com/zacheryph/pi/commit/ea70017f7657326e3bc8037425894b03cfab043d))
- 2026-10-08: Add spaced Nerd Font icons to subagent and todo titles ([fb5a26a](https://github.com/zacheryph/pi/commit/fb5a26a51f025779cbd12392e1cb99b786edcbaf))
- 2026-10-08: Improve subagent UX and add main-session profile defaults ([7215fa5](https://github.com/zacheryph/pi/commit/7215fa51006810c7fa5219a5965182c6c3c4bc64))
- 2026-10-08: Add fullscreen subagent watch overlay ([873e39c](https://github.com/zacheryph/pi/commit/873e39cea8d5083737fa58e684cecc5435d0b8ba))
- 2026-10-08: Compact subagent widget and configure project defaults ([a73808c](https://github.com/zacheryph/pi/commit/a73808ce78001ef21c1cea8b78e5beb714d7fada))
- 2026-10-08: Set up personal Pi bundle with vendored subagents ([091282e](https://github.com/zacheryph/pi/commit/091282e5a9b72a2b4efe73431a446244da652ddb))

## Initial import

- Source: [`gotgenes/pi-packages`](https://github.com/gotgenes/pi-packages),
  directory `packages/pi-subagents`, itself forked from
  [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).
- Pinned revision: `29bfbfe605d726c78f6120977b08666716e048f2`.
- Version: `23.2.0`.
- Recorded import date: 2026-10-22, described by the original import notes as
  this repository's first commit.
- License: MIT; original notice retained in [LICENSE](LICENSE).

Copied source, tests, docs, changelog, README, license, and type-build tooling.
Omitted media and contributor-only `.pi/` and `AGENTS.md` configuration.
The bundle loads `src/index.ts` as editable source, not a submodule or npm runtime
dependency. Do not also install the published upstream extension.

Earlier upstream history is in the
[pinned source changelog](https://github.com/gotgenes/pi-packages/blob/29bfbfe605d726c78f6120977b08666716e048f2/packages/pi-subagents/CHANGELOG.md).
