---
issue: 755
issue_title: "pi-subagents: always display model name in subagent stats bar and get_subagent_result report"
---

# Always show the subagent's model as `provider/id`

This plan also covers [#998] (show the Agent tool's model as `provider/id`, matching the agents widget).
Both issues rewrite the same expression in `resolveSpawnConfig`, so they land together.

## Release Recommendation

**Release:** ship independently

Neither [#755] nor [#998] is a step in the architecture roadmap (`grep -n '755\|998' docs/architecture/architecture.md` matches nothing), so no release batch applies.

## Problem Statement

A subagent's model is shown three different ways today, depending on where you look.
The agents widget always shows `[anthropic/claude-sonnet-5-5]`, read live from the record so a mid-run failover shows ([#954]).
The Agent tool's stats line shows the model only when it differs from the parent's, and then as a lowercased display name with `Claude` stripped (`sonnet 5.5`).
That label drops the provider, only fits Anthropic's naming, and cannot be pasted back into the tool's `model` argument ([#998]).
The `get_subagent_result` report — both the text the parent model reads and its collapsed TUI row — never names the model at all ([#755]).
For attribution (debugging, cost tracking, quality), every surface should say which model ran, in the same form.

## Goals

- The Agent tool's stats line always shows the subagent's model, whether or not it matches the parent's ([#755]).
- The label is `provider/id` via `formatModel`, the same form as the agents widget and the session viewer ([#998]).
- The label comes from the record's live `model` getter once the record exists, so a mid-run model switch or failover is reflected, matching the widget; before that, the spawn-resolved model.
- The `get_subagent_result` text report carries `Model: <provider/id>` on its own line after the `Type: … | Status: …` line, and its collapsed TUI row shows the model after the agent's display name.
- Remove the dead `modelName` copies the change would otherwise have to keep in sync (`AgentInvocation.modelName`, `buildInvocationTags`' returned `modelName`, `SpawnPresentation.modelName`).
- Non-breaking: display-only (`feat:`).
  No config key, default, or `SubagentRecord` field changes; the report text gains a line, and that text is not a documented contract.

## Non-Goals

- The background-spawn acknowledgement text (`Agent started in background. / Agent ID: … / Type: …`) is not given a model line; its TUI row already renders `detailBase.modelName` through `renderStats`, which this change fills.
- The foreground result text the parent model reads (`Agent completed in …`) gains no model line; the issue asked for the stats bar and the `get_subagent_result` report only.
- The agents widget (`src/ui/widget-renderer.ts`) and session viewer are unchanged; they already use `formatModel`.
- No `SubagentRecord` / service-API change — the public snapshot's model field is governed by ADR 0005 and is out of scope.
- Tool-result `details` already persisted in old session files keep their old `modelName` string (`sonnet 5.5`) and render as-is; no migration.
- The duplicated field mapping between `GetResultTool.buildReport` and `buildGetResultDetails` stays (the two shapes diverge deliberately; see Planning notes).

## Background

- `src/tools/spawn-config.ts` `resolveSpawnConfig` computes `modelName` from `model.name.replace(/^Claude\s+/i, "").toLowerCase()` only when `model.id !== parentModel.id`, and stores it three times: `agentInvocation.modelName`, `presentation.modelName`, `presentation.detailBase.modelName`.
  Only `detailBase.modelName` has a `src/` reader (`renderStats` in `src/tools/result-renderer.ts` via `AgentDetails.modelName`); `buildInvocationTags` returns `invocation.modelName` but its one caller destructures only `tags`.
- `resolveInvocationModel` (`src/session/model-resolver.ts`) returns the parent model when no model input is given, so `execution.model` is undefined only when the parent has no model and none was requested.
- `Subagent.model` (`src/lifecycle/subagent.ts`) resolves live session → model captured at release → `execution.model`; the widget's `modelTag` reads it through `formatModel`.
- `buildDetails` (`src/tools/helpers.ts`) builds `AgentDetails` from `detailBase` plus the record; callers are `runForeground`'s completion (`src/tools/foreground-runner.ts`) and `AgentTool.resumeExisting` (`src/tools/agent-tool.ts`).
  `runForeground`'s `streamUpdate` builds its own `AgentDetails` literal from `detailBase` and `recordRef?.…`, because it runs before the record exists.
- `src/tools/background-spawner.ts` spreads `detailBase` into the acknowledgement's details.
- `get_subagent_result`: `GetResultTool.buildReport` → `AgentReport` → `formatAgentReport` (`src/tools/get-result-report.ts`) for text; `buildGetResultDetails` → `GetResultDetails` → a **private** `renderStats` in `src/tools/get-result-renderer.ts` (distinct from the Agent tool's `renderStats` in `result-renderer.ts`) for the collapsed row.

## Design Overview

### Label helper

`src/ui/display.ts` gains, beside `formatModel`:

```typescript
/** A model's `provider/id` label, or undefined while the model is unknown. */
export function modelLabel(model: ModelIdentity | undefined): string | undefined {
  return model ? formatModel(model) : undefined;
}
```

It has four callers from step 3 onward (`buildDetails`, `streamUpdate`, `buildReport`, `buildGetResultDetails`), plus `resolveSpawnConfig` in step 2, so it lands in step 2 with its first caller rather than as a caller-less refactor.

### Spawn-time label

```typescript
// resolveSpawnConfig
const modelName = modelLabel(model); // always, not only when different from the parent
```

The `parentModelId` comparison and the `Claude`-stripping/lowercasing are deleted.

### Live label (Tell-Don't-Ask at the shared stamp point)

`buildDetails` is the shared point that stamps per-record fields, so the live model is stamped there once rather than at each caller:

```typescript
export function buildDetails(base, record: { …; model?: ModelIdentity }, overrides?) {
  return {
    ...base,
    modelName: modelLabel(record.model) ?? base.modelName,
    …
  };
}
```

`Subagent` satisfies `model?: ModelIdentity` structurally (`Model<any>` has `provider` and `id`).
`streamUpdate` cannot use `buildDetails` (no record yet), so it adds `modelName: modelLabel(recordRef?.model) ?? presentation.detailBase.modelName`.
The background acknowledgement keeps the spawn-time `detailBase.modelName`; the record's session may not exist yet.

### `get_subagent_result`

```typescript
export interface AgentReport {
  …
  /** The model's `provider/id`; undefined while an inherited model is still unknown. */
  model: string | undefined; // required-with-undefined, like resumeRefusal, so buildReport cannot omit it
}

// formatAgentReport
`Agent: ${id}\n` +
`Type: … | Status: … | …\n` +
(report.model ? `Model: ${report.model}\n` : "") +
`Description: …\n\n`
```

`GetResultDetails` gains `modelName?: string` (optional: persisted details from older sessions lack it), and the private `renderStats` in `get-result-renderer.ts` pushes it right after `displayName`: `Explore · anthropic/claude-haiku-4-5 · 44 tool uses · …`.
Both are filled from `modelLabel(record.model)` in `GetResultTool`.

### Observed before/after (Agent tool stats line, child on the parent's model `anthropic/claude-sonnet-5-5`)

| Surface                                     | Before                                 | After                                                                |
| ------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| Agent tool stats line, same model as parent | `thinking: high · ↻5≤30 · 3 tool uses` | `anthropic/claude-sonnet-5-5 · thinking: high · ↻5≤30 · 3 tool uses` |
| Agent tool stats line, `haiku` override     | `haiku 4.5 · …`                        | `anthropic/claude-haiku-4-5 · …`                                     |
| `get_subagent_result` text                  | no model                               | `Model: anthropic/claude-sonnet-5-5` line                            |
| `get_subagent_result` collapsed row         | `General · 3 tool uses · …`            | `General · anthropic/claude-sonnet-5-5 · 3 tool uses · …`            |

The strings are illustrative, derived from the code paths above, not captured output.

## Module-Level Changes

- `src/types.ts` — remove `AgentInvocation.modelName` (step 1).
- `src/ui/display.ts` — `buildInvocationTags` returns `{ tags }` only (step 1); add `modelLabel` (step 2); update `AgentDetails.modelName` doc ("Short model name if different from parent" → "`provider/id` of the model the agent runs") (step 2).
- `src/tools/spawn-config.ts` — drop `SpawnPresentation.modelName` and the `agentInvocation.modelName` member (step 1); `modelName = modelLabel(model)` (step 2).
- `src/tools/result-renderer.ts` — `renderStats` doc-comment example becomes `"anthropic/claude-haiku-4-5 · thinking: high · …"` (step 2).
- `src/tools/helpers.ts` — `buildDetails` record param gains `model?: ModelIdentity`; stamps `modelName` (step 3).
- `src/tools/foreground-runner.ts` — `streamUpdate` stamps `modelName` from `recordRef?.model` (step 3).
- `src/tools/get-result-report.ts` — `AgentReport.model`; `formatAgentReport` `Model:` line (step 4).
- `src/tools/get-result-renderer.ts` — `GetResultDetails.modelName?`; private `renderStats` pushes it (step 4).
- `src/tools/get-result-tool.ts` — `buildReport` and `buildGetResultDetails` fill the model (step 4).
- Tests: `test/tools/spawn-config.test.ts` (line ~83 same-as-parent assertion, line ~153 `agentInvocation` `toEqual`), `test/helpers/make-spawn-config.ts` (drop `presentation.modelName`, `agentInvocation.modelName`; keep `detailBase.modelName`), `test/helpers/make-spawn-config.test.ts` (lines ~23, 31, 37, 82, 87), `test/tools/result-renderer.test.ts` (optional: `"haiku"` fixtures to a `provider/id` string — they pass either way), `test/tools/helpers.test.ts`, `test/tools/foreground-runner.test.ts`, `test/tools/get-result-report.test.ts` (`makeReport` gains `model: undefined` default), `test/tools/get-result-renderer.test.ts`, `test/tools/get-result-tool.test.ts`.

Predicted unchanged, with the claim each rests on:

- `src/tools/background-spawner.ts` — it spreads `detailBase`, which step 2 fills; no code edit.
- `src/tools/agent-tool.ts` — `resumeExisting` already passes the `Subagent` to `buildDetails`, which picks up `record.model` structurally.
- `src/ui/widget-renderer.ts`, `src/ui/agent-widget.ts`, `src/ui/session-navigator.ts` — already `formatModel`.
- `test/tools/helpers.test.ts:30`'s `toEqual` on `buildDetails` — its record literal has no `model`, so `modelName` stays `base.modelName`.
- `README.md`, `docs/`, `.pi/skills/package-pi-subagents/SKILL.md`, `docs/architecture/architecture.md` — grepped for `modelName`, `buildInvocationTags`, `AgentInvocation`, `haiku ·`, `different from parent`: no current-behavior prose names the stats-line label (only `docs/architecture/history/phase-22-front-door-delivery.md` names `AgentInvocation`, as history; it survives as the tags snapshot).

## Test Impact Analysis

1. New tests: `modelLabel` (defined/undefined); `resolveSpawnConfig` same-as-parent now yields a label; `buildDetails` live-model override and fallback; `streamUpdate` live model; `formatAgentReport` `Model:` line present/absent; `get-result-renderer` collapsed row with model; `GetResultTool` end-to-end report and details from a record with a model.
2. Redundant: the `spawn-config.test.ts` "modelName is undefined when same as parent" assertion is inverted, not kept.
3. Kept as-is: the full-header exact-equality test in `get-result-report.test.ts` (line ~202) — `makeReport`'s `model: undefined` default keeps it byte-identical, and it becomes the "no model → no line" pin.

## Invariants at risk

- [#954]'s widget tag (live `record.model`, omitted while unknown) — `src/ui/widget-renderer.ts` is untouched; pinned by `test/widget-renderer.test.ts` and `test/ui/agent-widget.test.ts`.
- `GetResultDetails` never carries the result body or conversation (`get-result-renderer.ts` doc comment) — adding a short `modelName` string keeps that; pinned by `get-result-tool.test.ts` "details payload" (`not.toContain("report line 200")`).

## TDD Order

Every `feat:` commit carries the trailers paragraph (final paragraph, after `Refs`):

```text
Refs #755, #998

Co-authored-by: beilo <19225489+beilo@users.noreply.github.com>
```

The `Co-authored-by:` credits [#755]'s mechanism (always show the model; add it to `AgentReport`); it belongs on steps 2–4, whose designs come from that issue.
Verify with `git interpret-trailers --parse`.

1. **`refactor(pi-subagents): drop the unread modelName copies from the spawn config`**
   - Prepares step 2's friction: the label is stored three times and only `detailBase.modelName` is read, so step 2 would otherwise rewrite dead fields.
   - Remove `AgentInvocation.modelName` (`src/types.ts`), the `modelName` member of `buildInvocationTags`' return (type narrows to `{ tags: string[] }`), `SpawnPresentation.modelName`, and `presentation.modelName` / `agentInvocation.modelName` in `resolveSpawnConfig`.
   - Update `test/tools/spawn-config.test.ts` (delete the `presentation.modelName` assertion at line ~83 — step 2 re-asserts via `detailBase`; drop `modelName: undefined` from the `agentInvocation` `toEqual` at line ~153), `test/helpers/make-spawn-config.ts`, `test/helpers/make-spawn-config.test.ts` (re-point the `"haiku"` assertion at `presentation.detailBase.modelName`).
   - No new tests, no killing mutation (behavior-preserving); verify `pnpm --filter @gotgenes/pi-subagents run check` and the suite stay green.
2. **`feat(pi-subagents): always show the subagent's model as provider/id on the Agent tool's stats line`**
   - Red: `test/display.test.ts` — `modelLabel(makeModel({ provider: "anthropic", id: "claude-haiku-4-5" }))` is `"anthropic/claude-haiku-4-5"`; `modelLabel(undefined)` is `undefined`.
     `test/tools/spawn-config.test.ts` — same model as parent → `presentation.detailBase.modelName === "anthropic/<parent id>"`; a different model → its `provider/id` (not the lowercased `name`); no parent and no input → `undefined`.
   - Green: add `modelLabel`; `const modelName = modelLabel(model)`; update the `AgentDetails.modelName` and `renderStats` doc comments.
   - Killing mutations: restore `effectiveModelId !== parentModelId ? … : undefined` around the label → the same-as-parent test goes red; replace `modelLabel(model)` with `model?.name.toLowerCase()` → the `provider/id` test goes red; make `modelLabel` return `""` for undefined → the undefined case goes red.
3. **`feat(pi-subagents): show the model a subagent actually runs on in the Agent tool's stats line after a mid-run switch`**
   - Red: `test/tools/helpers.test.ts` — `buildDetails(base with modelName "anthropic/a", { …record, model: { provider: "openai", id: "b" } })` → `modelName === "openai/b"`; a record with no `model` keeps `base.modelName`.
     `test/tools/foreground-runner.test.ts` — a streamed update after `onSessionCreated` whose record's `model` differs from `detailBase.modelName` carries the record's label, and the completion `details` does too.
   - Green: `model?: ModelIdentity` on `buildDetails`' record param with `modelName: modelLabel(record.model) ?? base.modelName`; the same expression in `streamUpdate` over `recordRef?.model`.
   - Killing mutations: delete the `modelName:` line in `buildDetails` → the override test goes red (the fallback test stays green, as predicted — it pins the other class); delete the `modelName:` line in `streamUpdate` → the streaming test goes red.
4. **`feat(pi-subagents): name the subagent's model in the get_subagent_result report`**
   - Red: `test/tools/get-result-report.test.ts` — `formatAgentReport(makeReport({ model: "anthropic/claude-haiku-4-5" }))` contains the exact line `Model: anthropic/claude-haiku-4-5` between the `Type:` line and `Description:` (assert the full header with `toBe` on the leading slice); `model: undefined` → the existing exact-header test stays byte-identical.
     `test/tools/get-result-renderer.test.ts` — collapsed row with `modelName` renders `displayName · <model> · …` in that order; without it, unchanged.
     `test/tools/get-result-tool.test.ts` — a record built with a model (`makeStubExecution` / session stub carrying `makeModel(...)`) yields report text with `Model: <provider/id>` and `details.modelName` equal to it.
   - Green: `AgentReport.model`, the `Model:` line, `GetResultDetails.modelName?`, the `renderStats` push, and both `GetResultTool` builders.
   - Killing mutations: drop the `Model:` line from `formatAgentReport` → report test red; drop the `modelName` push in `get-result-renderer.ts`'s `renderStats` → renderer test red; set `model: undefined` in `buildReport` → tool test's text assertion red; omit `modelName` from `buildGetResultDetails` → tool test's details assertion red.

## Risks and Mitigations

- **Longer stats line** — `anthropic/claude-sonnet-5-5` is 27 characters against `sonnet 5.5`'s 10 (counted from the strings), now present on every run.
  The Agent tool's row is a wrapping `Text`, so nothing is clipped; accepted as the cost of the #998 format the widget already uses.
- **Inherited model before the session exists** — `execution.model` is undefined only with no parent model and no request; the label is then absent at spawn and fills from `record.model` once the session exists (step 3), matching the widget's "omitted while unknown" behavior.
- **Persisted details** — old sessions' `details.modelName` strings render unchanged; `GetResultDetails.modelName` is optional so older persisted get-result rows still type-check at render.

## Open Questions

- None.

[#755]: https://github.com/gotgenes/pi-packages/issues/755
[#954]: https://github.com/gotgenes/pi-packages/issues/954
[#998]: https://github.com/gotgenes/pi-packages/issues/998
