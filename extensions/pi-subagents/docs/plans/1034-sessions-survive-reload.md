---
issue: 1034
issue_title: "pi-subagents: /subagents:sessions is empty after /reload"
---

# Rebuild the session picker from persisted run records

## Release Recommendation

**Release:** ship independently

The issue belongs to no improvement roadmap or release batch (`architecture.md` does not reference #1034), and it is a self-contained bug fix to the `/subagents:sessions` command.

## Problem Statement

After `/reload`, `/subagents:sessions` reports "No subagent sessions to view." even though subagents ran earlier in the same Pi session and their child session files are still on disk.

What the operator sees, in order: run a subagent and let it finish, open `/subagents:sessions` and see it listed, run `/reload`, open `/subagents:sessions` again and see nothing.

Pi's `AgentSession.reload()` emits `session_shutdown` (reason `reload`) to the old extension runner, which aborts and disposes the old `SubagentManager`, then re-runs every extension factory and emits `session_start` (reason `reload`).
The new factory builds a fresh, empty `SubagentManager` in `src/index.ts`, and the command builds its picker solely from `manager.listAgents()`.

## Goals

- Subagents that reached a terminal state earlier in the session stay viewable in `/subagents:sessions` after `/reload`, opened from their persisted transcript file.
- The source is the parent session's own `subagents:record` custom entries, read from the whole session file (`ctx.sessionManager.getEntries()`, every branch), per the operator's decision.
- Each `subagents:record` entry additionally records the run's `outputFile` (transcript path) and `toolUses`, which the picker label and the snapshot source need.
- Non-breaking: the persisted entry gains two fields, and the picker lists more entries than before; no existing field, default, or output shape changes.

The same mechanism also lists a session's earlier subagents after `/resume` or in a forked session, where the picker is empty today.
That follows from reading the session file and is intended, not a side effect to suppress.

## Non-Goals

- **A manager-to-manager handoff across `/reload`** (a `globalThis` symbol the old manager parks records on).
  Rejected at the planning gate: it is a new cross-instance runtime mechanism, it reaches only `/reload` and not `/resume`, and the parked records hold objects from the previous module instance.
- **Scanning `<parent>/tasks/*.jsonl`.**
  Rejected at the planning gate: child file names carry no agent id and the files record no agent type or task description, so a scanned entry could not be labeled.
- **Recovering runs recorded before this change.**
  Their `subagents:record` entries carry no `outputFile`, so they stay unlisted after a reload; the gap is one-time and closes for every run recorded after upgrade.
- **Restoring live state** (steering, streaming, resume) for a reloaded run.
  A rebuilt entry is a read-only disk snapshot, exactly like a record whose session the retention sweep released.
- **Changing the snapshot label marker.**
  A rebuilt entry reuses the existing `· session released (snapshot)` marker; its session was released, by the reload rather than the sweep.
- **The `SubagentRecord` public snapshot** (ADR 0005) and the `subagents:*` event payloads are untouched; this changes only the session-entry contract, which nothing in the repo reads today.

## Background

- `src/observation/subagent-events-observer.ts` — `SubagentEventsObserver.persistAndNotify` appends `subagents:record` on every terminal transition (fresh and resumed) with an inline literal of nine fields: `id, type, description, status, result, error, turnBudget, startedAt, completedAt`.
  A resumed run appends a second entry with the same `id`.
  `grep -rn "subagents:record" packages/pi-subagents/src` finds only this writer; no reader exists, and `README.md` does not document the entry.
- `src/ui/session-navigation.ts` — `listNavigableAgents(agents, registry)` turns each in-memory record into a `live` entry (session ready) or a `snapshot` entry (released, has `outputFile`), live first.
  `LabelFields` (`type, description, status, startedAt, completedAt, toolUses`) is already the structural subset a persisted run summary satisfies; `buildLabel` and `buildHeading` take it.
- `src/ui/session-navigator.ts` — `SessionNavigatorHandler.handle({ ui, agents, registry, cwd, readFile })` lists entries, prompts `ui.select`, and opens `fileSnapshotSource(entry.outputFile, readFile)` for a snapshot.
- `src/index.ts` — registers `/subagents:sessions`, passing `agents: manager.listAgents()`.
  The command context is an `ExtensionContext`, whose `sessionManager: ReadonlySessionManager` exposes `getEntries()` (verified in `../../pi/packages/coding-agent/src/core/extensions/types.ts` and `core/session-manager.ts`).
- `Subagent.outputFile` survives `releaseSession()` (`_releasedOutputFile`), and at terminal-transition time the session is not yet released, so the writer always sees it when a session was created.
- Agent ids are `randomUUID().slice(0, 17)`, so a post-reload run cannot collide with a persisted id.
- Fallow zones (`pnpm --silent fallow guard`, run at planning time): `ui` may import `config`, `core`, `lifecycle`, `ui` and **not** `observation`; `observation` may import `core`, `lifecycle`, `observation`, `ui`.
  The entry contract therefore lives at the package root (zone `core`), importable by both writer and reader.

## Design Overview

### The entry contract owns one module

New `src/persisted-record.ts` (root, zone `core`) owns the `subagents:record` contract, writer and reader side:

```ts
export const SUBAGENT_RECORD_ENTRY = "subagents:record";

/** What `persistAndNotify` appends for each terminal run. */
export interface PersistedSubagentRecord {
  readonly id: string;
  readonly type: SubagentType;
  readonly description: string;
  readonly status: SubagentStatus;
  readonly result: string | undefined;
  readonly error: string | undefined;
  readonly turnBudget: TurnBudget | undefined;
  readonly startedAt: number;
  readonly completedAt: number | undefined;
  readonly outputFile: string | undefined; // new
  readonly toolUses: number;               // new
}

/** The fields the reader validates and returns — what the picker labels and opens. */
export type PersistedRunSummary = Pick<
  PersistedSubagentRecord,
  "id" | "type" | "description" | "status" | "startedAt" | "completedAt" | "toolUses" | "outputFile"
>;

/** Narrow input: the `Subagent` getters the builder reads. */
export function toPersistedRecord(record: PersistedRecordSource): PersistedSubagentRecord;

/** Narrow input: the session-entry fields the reader inspects. */
export interface SessionEntryLike { readonly type: string; readonly customType?: string; readonly data?: unknown }

export function readPersistedRuns(entries: readonly SessionEntryLike[]): PersistedRunSummary[];
```

`PersistedRecordSource` is a `Pick<Subagent, …>` of exactly the eleven getters `toPersistedRecord` reads (ISP).
`readPersistedRuns` returns `PersistedRunSummary`, not the full record, because it validates only the fields the picker uses; claiming `result`/`error`/`turnBudget` without validating them would make the type lie.

`readPersistedRuns` semantics:

- Keeps only `type === "custom"` entries whose `customType === SUBAGENT_RECORD_ENTRY`.
- Validates `data`: `id`, `type`, `description` strings; `status` one of the six `SubagentStatus` members; `startedAt` and `toolUses` numbers; `completedAt` number or absent; `outputFile` string or absent.
  Anything else is skipped silently, including every pre-upgrade entry (it lacks `toolUses`).
- Last entry per `id` wins, so a resumed run reports its latest outcome.
- Returns newest first by `startedAt`, matching `listAgents()`'s order.

### Writer

`persistAndNotify` replaces its inline literal with `this.appendEntry(SUBAGENT_RECORD_ENTRY, toPersistedRecord(record))`.
The literal moves verbatim into `toPersistedRecord`; then the two new fields are added.

### Reader: picker composition

`listNavigableAgents(agents, registry, persisted)` gains a third input.
After the existing live/snapshot pass, it appends a `snapshot` entry for each persisted run whose `id` is not among `agents` (live or released) and which has an `outputFile`:

```ts
const known = new Set(agents.map((a) => a.id));
for (const run of persisted) {
  if (known.has(run.id) || !run.outputFile) continue;
  snapshots.push({ kind: "snapshot", outputFile: run.outputFile, heading: buildHeading(run, registry), label: buildLabel(run, registry, true) });
}
```

An in-memory record always wins over its persisted twin: a run completed after the reload is in both the new manager and the session file.
Order stays live first, then in-memory snapshots, then persisted snapshots, each newest first.

`SessionNavigatorParams` gains a **required** `sessionEntries: readonly SessionEntryLike[]`; `handle()` calls `listNavigableAgents(agents, registry, readPersistedRuns(sessionEntries))`.
Making it required keeps the composition root from forgetting it; the test helper from Step 1 supplies `[]` by default.
Passing raw entries rather than parsed runs lets a handler test drive the whole reload scenario from realistic entry shapes, leaving `index.ts` a one-line relay: `sessionEntries: ctx.sessionManager.getEntries()`.

### Edge cases (each tested)

| Case                                                      | Behavior                                          | Step |
| --------------------------------------------------------- | ------------------------------------------------- | ---- |
| Foreign custom entry / non-custom entry                   | ignored                                           | 4    |
| Resumed run (two entries, same id)                        | last wins                                         | 4    |
| Pre-upgrade entry (no `toolUses`) or malformed `status`   | skipped                                           | 4    |
| Persisted run with no `outputFile` (stopped while queued) | not listed                                        | 5    |
| Persisted id also in `agents`                             | in-memory entry only                              | 5    |
| Reload scenario: `agents: []`, one persisted entry        | picker offers it; picking opens the file snapshot | 5    |

### Predicted-unchanged files

- `src/ui/session-navigator.ts`'s `TranscriptPane`, `probeTuiMode`, and mount options: unchanged, because a rebuilt entry is an ordinary `snapshot` entry and flows through the existing `fileSnapshotSource` branch.
- `test/composition-root.test.ts`: unchanged; the assessor confirmed it does not drive the `/subagents:sessions` handler (its `sessionManager` stubs are `{}`).
- `src/handlers/lifecycle.ts`, `src/lifecycle/subagent-manager.ts`: unchanged; the fix reads the session file and does not alter the shutdown or `clearCompleted` path.

## Module-Level Changes

| File                                                | Change                                                                                                                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/persisted-record.ts`                           | **New.** `SUBAGENT_RECORD_ENTRY`, `PersistedSubagentRecord`, `PersistedRecordSource`, `toPersistedRecord`, `SessionEntryLike`, `PersistedRunSummary`, `readPersistedRuns`.                            |
| `src/observation/subagent-events-observer.ts`       | `persistAndNotify` delegates to `toPersistedRecord`; the entry gains `outputFile` and `toolUses`.                                                                                                     |
| `src/ui/session-navigation.ts`                      | `listNavigableAgents` takes `persisted: readonly PersistedRunSummary[]` and appends rebuilt snapshot entries; doc comment updated.                                                                    |
| `src/ui/session-navigator.ts`                       | `SessionNavigatorParams.sessionEntries` (required); `handle()` parses and passes it; class doc comment names the persisted source.                                                                    |
| `src/index.ts`                                      | `/subagents:sessions` passes `sessionEntries: ctx.sessionManager.getEntries()`.                                                                                                                       |
| `test/persisted-record.test.ts`                     | **New.** Builder and reader tests.                                                                                                                                                                    |
| `test/observation/subagent-events-observer.test.ts` | Both exact `subagents:record` assertions (the "eight persisted fields" tests, lines ~92 and ~184) gain `outputFile` and `toolUses` (fixture default `toolUses: 3`); titles drop the hard-coded count. |
| `test/ui/session-navigation.test.ts`                | New nested `describe("persisted runs")` under `listNavigableAgents`.                                                                                                                                  |
| `test/ui/session-navigator.test.ts`                 | Local `handleWith` helper (Step 1); new reload-scenario tests.                                                                                                                                        |
| `README.md`                                         | `### /subagents:sessions`: one sentence that runs from earlier in the session (before a `/reload`, or in a resumed session) open from their saved transcript.                                         |
| `docs/architecture/architecture.md`                 | Module tree: add `persisted-record.ts` among the root files (near `types.ts`, line ~346); the navigator paragraph (line ~443) gains a sentence on the persisted source.                               |
| `.pi/skills/package-pi-subagents/SKILL.md`          | The "sit at the root" sentence under Domain organization lists `persisted-record.ts`.                                                                                                                 |

## Test Impact Analysis

1. **New tests enabled:** the reader becomes a pure function over entry arrays, so filtering, last-wins, validation, and ordering are unit-testable without a session; the handler's reload scenario becomes testable from raw entries.
2. **Redundant tests:** none; the observer's exact assertions stay, as the writer-side pin of the entry shape, and `toPersistedRecord` tests pin the builder independently.
3. **Unchanged tests:** existing `listNavigableAgents` and handler tests keep their assertions; they pass `[]` for the new input and must stay green, pinning that no persisted input means today's behavior.

## Invariants at risk

| Invariant                                                                                    | Pinned by                                                                                                                         |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Live entries before snapshot entries                                                         | `session-navigation.test.ts` "orders live entries before snapshot ones" (extended in Step 5 to include a persisted snapshot last) |
| A released in-memory record lists as a snapshot with the `session released (snapshot)` label | `session-navigation.test.ts` "makes a released record … a snapshot entry"                                                         |
| Unreadable transcript file reports "Could not read the session transcript file."             | existing handler tests at lines ~614/631, which run through the same branch a rebuilt entry takes                                 |
| `subagents:record` still written once per terminal transition, fresh and resumed             | observer tests "emits exactly once and appends exactly once per call" and the resumed-path assertion                              |

## TDD Order

1. **`test(pi-subagents): share the session-navigator handle call in a helper`** Prepares the friction of Step 5: eight `new SessionNavigatorHandler().handle({ ui, agents, registry, cwd: "/test/cwd", readFile })` calls in `test/ui/session-navigator.test.ts` would each need `sessionEntries`.
   Add a local `handleWith(ui, agents, overrides?)` that defaults `registry`, `cwd`, and `readFile: noReadFile`, and migrate the eight calls.
   Behavior-neutral; no new tests, so no killing mutation.
   Verify: file green, `pnpm --filter @gotgenes/pi-subagents run check`.

2. **`refactor(pi-subagents): own the subagents:record entry shape in one module`** Create `src/persisted-record.ts` with `SUBAGENT_RECORD_ENTRY`, `PersistedSubagentRecord` (the current nine fields only), `PersistedRecordSource`, and `toPersistedRecord`, moving the inline literal verbatim; `persistAndNotify` calls it.
   Re-read the moved literal against `code-design` before committing.
   Tests: `test/persisted-record.test.ts` asserts `toPersistedRecord(createTestSubagent({...}))` with `toStrictEqual` against the nine-field object (so a stray key fails).
   Killing mutation: in `toPersistedRecord`, replace `completedAt: record.completedAt` with `completedAt: record.startedAt`.
   The new test goes red; the observer tests go red too (they still assert `completedAt: 2000`).

3. **`feat(pi-subagents): record each run's transcript path and tool count in its session entry`** Add `outputFile` and `toolUses` to `PersistedSubagentRecord` and `toPersistedRecord`.
   Tests: the Step 2 builder test gains both fields, using a fixture with `outputFile: "/tasks/a.jsonl"` and `toolUses: 7`; both observer exact assertions gain `outputFile` and `toolUses: 3` (the `createTestSubagent` default), and their titles lose "eight".
   Killing mutations: delete the `outputFile` line from `toPersistedRecord` (the builder test goes red); delete the `toolUses` line (the builder test and both observer assertions go red).

4. **`refactor(pi-subagents): read persisted run summaries from session entries`** Add `SessionEntryLike`, `PersistedRunSummary`, and `readPersistedRuns`; no consumer yet.
   Tests in `test/persisted-record.test.ts`, `describe("readPersistedRuns")` with one nested block per class:
   - filtering: a `subagents:record` entry among a foreign custom entry (`customType: "other"`) and a `message` entry yields one summary;
   - last wins: two entries with the same id (statuses `completed` then `error`) yield one summary with `error`;
   - validation: a pre-upgrade entry (nine fields, no `toolUses`), and one with `status: "bogus"`, both yield `[]`; an entry with no `outputFile` is kept with `outputFile: undefined`;
   - order: two ids with `startedAt` 1000 and 2000 come back as 2000, then 1000;
   - round trip: `readPersistedRuns([{ type: "custom", customType: SUBAGENT_RECORD_ENTRY, data: toPersistedRecord(record) }])` returns the summary of `record`, pinning that the writer and reader agree.
   Killing mutations, one per class:
   - filtering: drop the `customType === SUBAGENT_RECORD_ENTRY` check.
     The filtering test goes red, because the foreign entry's `data` is a valid record shape in the fixture.
   - last wins: skip an id already in the map instead of overwriting it.
     The last-wins test goes red.
   - validation: delete the `typeof toolUses === "number"` check.
     The pre-upgrade test goes red.
   - order: sort ascending.
     The order test goes red.

5. **`fix(pi-subagents): keep earlier subagents in /subagents:sessions after /reload`** `listNavigableAgents` takes `persisted`.
   `SessionNavigatorParams.sessionEntries` is required, and `handle()` passes `readPersistedRuns(sessionEntries)`.
   The `index.ts` command passes `ctx.sessionManager.getEntries()`.
   Update the existing `listNavigableAgents([...], registry)` calls to pass `[]`, and point `handleWith` at `sessionEntries: []`.
   This step also lands the `README.md`, `architecture.md`, and `SKILL.md` updates.
   Tests:
   - `session-navigation.test.ts`, `describe("persisted runs")`:
     - a persisted run with `outputFile` and no in-memory twin becomes a snapshot entry with label `Agent (<desc>) · 7 tools · completed · <dur> · session released (snapshot)`;
     - a persisted run whose id matches an in-memory record lists once, as the in-memory entry;
     - a persisted run with no `outputFile` is not listed;
     - the order test gains a persisted snapshot after a live and an in-memory snapshot entry.
   - `session-navigator.test.ts`, the reload scenario: `agents: []` with `sessionEntries: [{ type: "custom", customType: "subagents:record", data: {...} }]`.
     The picker is offered that label (not "No subagent sessions to view."), and picking it calls `readFile` with the entry's `outputFile`.

   Killing mutations:
   - persisted entry: make `listNavigableAgents` ignore `persisted`.
     The first navigation test and the handler reload test go red.
   - id dedupe: remove `known.has(run.id) ||`.
     The dedupe test goes red, with two entries.
   - no transcript: remove `|| !run.outputFile`.
     The no-`outputFile` test goes red.
   - wiring: in `handle()`, pass `[]` instead of `readPersistedRuns(sessionEntries)`.
     The handler reload test goes red.

   The `index.ts` relay line has no automated pin, because the composition root does not drive commands.
   Verify it live: run a subagent, `/reload`, then `/subagents:sessions` lists it and opens its transcript.
   Then run the full suite, `check`, and `lint`.

## Risks and Mitigations

- **A large session file makes the command slow.**
  `getEntries()` is in memory (Pi loaded the file at session start), and the reader is one linear pass over the entries with a cheap `type`/`customType` test per entry, so this is estimated negligible.
  The transcript itself is read only on pick.
- **A rebuilt entry's `outputFile` no longer exists** (a user deleted the tasks directory, or a fork's source session moved).
  `fileSnapshotSource` throws, and the existing catch reports "Could not read the session transcript file."; the existing handler test covers that branch.
- **A run in flight at `/reload` is not listed afterwards.**
  It is aborted by the old manager's `handleSessionShutdown`, and it is listed only if its terminal `subagents:record` append reaches the session before Pi invalidates the old runner.
  This is unverified at planning time and outside the issue's scenario, which uses finished runs.
  Check it during Step 5's live verification and record the outcome in the retro.
  If it is missing, file a follow-up rather than widening this fix.
- **The two `ui.select` labels collide.**
  The picker matches the choice back by label, so two runs with the same agent, task, tool count, status, and duration would resolve to the first.
  This is pre-existing for in-memory records, and persisted runs widen the pool only slightly.
  It is out of scope.

## Open Questions

- Whether an aborted-at-reload run's entry survives the shutdown (see Risks).
  Resolve it during live verification, and file a follow-up only if it is missing and the operator wants it.
