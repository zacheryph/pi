---
issue: 415
issue_title: "Migrate pi-subagents-worktrees config loader to loadLayeredSettings"
---

# Migrate the worktrees config loader to `loadLayeredSettings`

## Problem Statement

`pi-subagents-worktrees/src/config.ts` carries its own copy of the read-sanitize-warn-merge idiom (`readConfigFile`, `globalPath`, `projectPath`) that issue [#380] extracted into the shared `loadLayeredSettings<T>` helper and published as `@gotgenes/pi-subagents/settings`.
This is the only cross-package production clone the duplication detector reports.
Consuming the shared helper deletes the local copy and exercises the `./settings` subpath in a real cross-package consumer.

## Goals

- Replace the inlined loader in `src/config.ts` with a single `loadLayeredSettings` call.
- Remove the now-unused `readConfigFile`, `globalPath`, `projectPath`, and the `node:fs` / `node:path` imports.
- Raise the `@gotgenes/pi-subagents` floor (peer and dev) to `16.4.0`, the release that introduced the `./settings` subpath.
- Preserve the observable behavior of `loadWorktreesConfig`: same signature, same merge semantics (project overrides global), same return shape.

## Non-Goals

- No change to `loadWorktreesConfig`'s public signature, return type, or to `WorktreesConfig`.
- No change to `worktree.ts`, `workspace-provider.ts`, `index.ts`, or any non-config module.
- No change to the documented config file layout (global `<agentDir>/subagents-worktrees.json`, project `<cwd>/.pi/subagents-worktrees.json`) — only the loader implementation changes.
- Do not touch `@gotgenes/pi-subagents` itself — the helper is already published; this is a consumer-only change.

## Background

The shared helper (`packages/pi-subagents/src/layered-settings.ts`, exported via `@gotgenes/pi-subagents/settings`) is:

```typescript
loadLayeredSettings<T>({ agentDir, cwd, filename, sanitize, warnLabel }): Partial<T>
```

It reads `<agentDir>/<filename>` and `<cwd>/.pi/<filename>`, runs each through `sanitize`, warns to stderr on malformed JSON, and shallow-merges with the project layer winning — exactly the idiom currently inlined in `config.ts`.

Relevant constraints:

- Worktrees resolves `@gotgenes/pi-subagents` from the **published registry release**, not a workspace symlink (the repo sets `linkWorkspacePackages: false`).
  The `./settings` subpath ships as `src/layered-settings.ts` plus a rolled `dist/settings.d.ts`; both are present from v16.4.0 onward.
- The package currently has `@gotgenes/pi-subagents@15.0.1` nested in `node_modules` (no `./settings`).
  After the dep-floor bump, `pnpm install` must run to pull v16.4.0 so the import resolves at type-check and runtime.

## Design Overview

The migration is a like-for-like substitution: the helper's contract matches the local loader's behavior.
The local `sanitize` function and the `WorktreesConfig` interface stay; only the read/merge plumbing is replaced.

Target `config.ts` (call site sketch — verifies the Tell-Don't-Ask interaction with the published helper):

```typescript
import { loadLayeredSettings } from "@gotgenes/pi-subagents/settings";

export function loadWorktreesConfig(agentDir: string, cwd: string): WorktreesConfig {
  const merged = loadLayeredSettings<WorktreesConfig>({
    agentDir,
    cwd,
    filename: CONFIG_FILENAME,
    sanitize,
    warnLabel: "pi-subagents-worktrees",
  });
  return { worktreeAgents: merged.worktreeAgents ?? [] };
}
```

`CONFIG_FILENAME` (`"subagents-worktrees.json"`) and `sanitize` are retained as-is; `loadWorktreesConfig` hands them to the helper instead of driving the read loop itself.

### One observable behavior change: the warning text

The local loader emits:

```text
[pi-subagents-worktrees] Ignoring malformed config at <path>: <reason>
```

The shared helper emits a fixed wording with the same bracketed label (`warnLabel: "pi-subagents-worktrees"`):

```text
[pi-subagents-worktrees] Ignoring malformed settings at <path>: <reason>
```

The only delta is the word `config` → `settings`.
This is stderr text, not an API surface, a return shape, or a config default, so it is **not a breaking change** for users.
It is test-observable: `config.test.ts` asserts the old wording and must be updated.

### Edge cases (all preserved by the helper)

- No files → `{ worktreeAgents: [] }`.
- Global only / project only → that layer's value.
- Both present → project overrides global (shallow spread).
- `worktreeAgents` not an array, or array with non-string entries → dropped by `sanitize` → `[]`.
- Malformed JSON → one stderr warning, falls back to `[]`, startup proceeds.

## Module-Level Changes

- `packages/pi-subagents-worktrees/src/config.ts`
  - Remove imports `existsSync`, `readFileSync` (`node:fs`) and `join` (`node:path`).
  - Add `import { loadLayeredSettings } from "@gotgenes/pi-subagents/settings";`.
  - Remove `globalPath`, `projectPath`, and `readConfigFile`.
  - Rewrite `loadWorktreesConfig` to call `loadLayeredSettings` (sketch above).
  - Keep `WorktreesConfig`, `CONFIG_FILENAME`, and `sanitize`.
  - Update the file-header docstring: it currently says "Mirrors the load/sanitize pattern in pi-subagents' settings.ts" — reword to state it now consumes the shared `loadLayeredSettings` helper.
- `packages/pi-subagents-worktrees/test/config.test.ts`
  - Change the malformed-JSON assertion from `toContain("Ignoring malformed config")` to `toContain("Ignoring malformed settings")`.
  - All other assertions stay unchanged (behavior is preserved).
- `packages/pi-subagents-worktrees/package.json`
  - `peerDependencies["@gotgenes/pi-subagents"]`: `>=15.0.0` → `>=16.4.0`.
  - `devDependencies["@gotgenes/pi-subagents"]`: `^15.0.1` → `^16.4.0`.
- `pnpm-lock.yaml`
  - Updated by `pnpm install` after the dep bump (pulls v16.4.0 into the worktrees package's resolution).

No other modules import the removed symbols (`readConfigFile`, `globalPath`, `projectPath` are private to `config.ts`).
`index.ts` calls only `loadWorktreesConfig`, whose signature is unchanged.
The package ships no `package-pi-subagents-worktrees` skill and no architecture docs that reference the removed internals; `README.md`'s Configuration section documents only the file layout, which is unchanged.

## Test Impact Analysis

This is a refactor that replaces an implementation behind an unchanged public function; it does not enable new lower-level unit tests, because the extracted helper already has its own coverage in `pi-subagents`.

1. **New tests enabled** — none.
   `loadLayeredSettings` is tested in `packages/pi-subagents/test/...`; re-testing it here would duplicate that coverage.
2. **Tests that become redundant** — none are removed.
   The `config.test.ts` cases now verify the *integration* (that `loadWorktreesConfig` wires the helper correctly with the right `filename`, `sanitize`, and `warnLabel`), which is still worth pinning.
3. **Tests that must stay as-is** — all six existing `config.test.ts` cases, except the one warning-text assertion that updates `config` → `settings`.
   They exercise the contract worktrees depends on regardless of the underlying loader.

## Invariants at risk

The duplication-detector outcome from [#380] (Phase 17 Step 9): `pnpm fallow:dupes` no longer reports the `settings.ts` ↔ `config.ts` clone.
[#380] resolved its half by extraction; this change resolves the worktrees half by consuming the helper, which removes the cloned lines entirely.
No prose-only invariant is at risk — the behavior is pinned by `config.test.ts`.

## TDD Order

1. **refactor — consume the shared helper.** (single cycle)
   - Red: update the malformed-JSON assertion in `test/config.test.ts` to `toContain("Ignoring malformed settings")`.
     Run `pnpm --filter @gotgenes/pi-subagents-worktrees run test` — fails, because the current local loader still emits "config".
   - Green: in the same commit, bump both `@gotgenes/pi-subagents` floors in `package.json` (`>=16.4.0` / `^16.4.0`), run `pnpm install` to pull v16.4.0, then rewrite `src/config.ts` to call `loadLayeredSettings` and delete `readConfigFile` / `globalPath` / `projectPath` and the `node:fs` / `node:path` imports, and update the file-header docstring.
   - Verify: `pnpm --filter @gotgenes/pi-subagents-worktrees run check && pnpm --filter @gotgenes/pi-subagents-worktrees run lint && pnpm --filter @gotgenes/pi-subagents-worktrees run test`, plus `pnpm fallow dead-code` (the dep-floor change touches `package.json`).
   - Commit: `refactor(pi-subagents-worktrees): consume shared loadLayeredSettings helper (#415)`.

The dep-floor bump, `pnpm install`, the `config.ts` rewrite, the docstring, and the test-assertion update belong in **one commit**: the new import does not resolve until v16.4.0 is installed, and the removed internals leave the module non-compiling until the rewrite lands.

## Risks and Mitigations

- **`pnpm install` cannot fetch v16.4.0 (offline / registry unavailable).**
  The tag `pi-subagents-v16.4.0` exists and the version is published; if the local store lacks it, `pnpm install` fetches it.
  If the environment is offline, this step blocks — surface the failure rather than pinning to a stale local copy.
- **Warning-text change surprises a downstream log scraper.**
  Unlikely (stderr diagnostic, not a contract); documented above and pinned by the updated test.
- **Type resolution against the `./settings` subpath fails.**
  Mitigated by the floor bump to the exact release that ships `dist/settings.d.ts`; `pnpm run check` catches any mismatch before commit.

## Open Questions

- None blocking.
  The prerequisite (pi-subagents v16.4.0 published) is satisfied, so this can land immediately.

[#380]: https://github.com/gotgenes/pi-packages/issues/380
