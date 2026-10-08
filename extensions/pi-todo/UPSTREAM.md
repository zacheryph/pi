# Upstream provenance

- Selected base: [`@99percentpeople/pi-todo` 1.2.8](https://github.com/99percentpeople/pi-extensions/tree/a7ae6b89a211c35b657e886e9ceeafbf51616c22/extensions/todo).
- Repository: `https://github.com/99percentpeople/pi-extensions.git`
- Pinned commit: `a7ae6b89a211c35b657e886e9ceeafbf51616c22`
- Imported 2026-10-08 by sparse cloning into `extensions/pi-todo/.upstream`,
  extracting the todo state engine/license, then removing the temporary checkout.
  This is vendored source, not a submodule or nested Git repository.
- `src/state.ts` retained byte-for-byte from `extensions/todo/state.ts` at that
  commit. Preserve its pure validation/replay API when updating the fork.
- `LICENSE` retains Zach Yuen's MIT copyright and permission notice.

## Local adaptation

Upstream provides stable-key snapshots, optional revision checks, immutable state,
cycle/missing-dependency validation, readiness enforcement, completed-task pruning,
and validated branch replay. We wrap that engine rather than rebuilding graph
validation. Explicit `clear completed` invokes its pruning helper; no automatic
cleanup runs.

Upstream extension entry/settings/UI are replaced locally:

- `src/actions.ts`: explicit list/upsert/replace/remove/clear operations. Upsert
  preserves omitted keys and defaults new tasks to pending. Optional single-active
  policy never demotes another task implicitly.
- `src/index.ts`: sequential tool, durable custom-entry journal for nested tools
  and user commands, branch restoration, context-only current-state sync while
  model history lacks a current full result, independent rendering lifecycle.
  No forced continuation or steering messages.
- `src/replay.ts`: validated local `pi-personal:todo-state` journals take precedence
  over potentially delayed direct results. Upstream snapshots remain a fallback
  until a branch has a local checkpoint; pure engine remains unchanged.
- `src/commands.ts`: browser/add/update/remove/clear/settings commands; revision
  and session/branch-generation guards around asynchronous dialogs; no prompt
  submission.
- `src/config.ts`: independent global/project layered settings, no shared-settings
  package dependency. Project writes preserve unrelated settings fields.
- `src/ui/`: compact widget and browser locally adapted from this repository's
  subagents/system-insights conventions. Helpers stay local so standalone loading
  does not depend on another extension's internal modules.
- `test/`: local regression tests for validation, additive operations, persistence,
  lifecycle/context behavior, commands/settings, and terminal rendering.

The upstream tool accepts an authoritative full list and deletes omitted keys.
Our tool requires an explicit action and only `replace` has those semantics. Agent
instructions using upstream's old schema need updating. No rpiv schema migration
or modifications to personal package installation settings are performed.

See [comparison report](docs/comparison.md) for alternatives and decision rationale.
