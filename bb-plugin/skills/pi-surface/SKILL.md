---
name: pi-surface
description: Inspect Pi sessions that the Pi surface plugin shows in bb, or show a canned fixture session on a thread to preview the plugin's UI without a model run.
---

# Pi surface

The Pi surface plugin shows Pi threads that run the pi-personal bundle's
`pi-bb` extension: todos and subagents above the composer, stash, worktrees and
pull requests in the thread context, a **Pi** side-panel tab, row badges and a
**Pi sessions** page.

## Commands

- `bb pi-surface list [--json]` lists the sessions the plugin holds: thread id,
  `live` or `fixture`, status and name. A live session stays listed for 15
  seconds after its Pi process disconnects.
- `bb pi-surface fixture --thread <id>` shows a canned session (7 tasks, 3
  subagents, 4 stash entries, 2 worktrees, 3 pull requests, 1 open question) on
  that thread. It refuses a thread whose Pi session is connected.
- `bb pi-surface clear --thread <id>` removes that thread's fixture. Always clear
  a fixture you installed once you are done.

Fixtures live in memory only and never raise a form in the thread's composer.
