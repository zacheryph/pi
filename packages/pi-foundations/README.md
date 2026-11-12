# pi-foundations

Shared settings, model lookup, guards and plain-data formatting primitives for this source bundle. This is a
private library, not a Pi extension. Its settings module imports `getAgentDir`
from Pi and `sanitizeLine` from `pi-ui`'s dependency-free `src/text.ts`; nothing
else beyond Node. Import its modules through aliases such as
`#foundations/settings` and `#foundations/format`. Workspace manifests map these
to package exports; root `file:` dependencies create the links for Git installs.

- `src/settings.ts`: `defineSettings` declares an extension's settings once:

  ```ts
  export const stashSettings = defineSettings({
    name: "stash", // <agent dir>/stash.json (and .pi/stash.json when layered), "[pi-stash]"
    scope: "global", // or "layered": global, then the project file overrides
    fields: {
      retentionDays: number({ default: 30, min: 0, exclusiveMin: true }),
      maxEntryBytes: int({ default: 20 * 1024 * 1024, min: 1 }),
    },
  });
  export type StashConfig = SettingsOf<typeof stashSettings>;

  stashSettings.load(cwd, agentDir?); // fully defaulted and typed
  stashSettings.defaults(cwd?, agentDir?); // the same without reading files
  todoSettings.save(cwd, patch); // project file; definitions with `writable: true`
  ```

  Field helpers: `bool`, `int({min, max})`, `number({min, max, exclusiveMin})`,
  `oneOf([...])`, `string({trim, nonEmpty})`, `optional(...)` around a helper
  given no `default`, and `list(item, {unique})` and `record(item)`, which keep
  valid members and default to a fresh empty array or object. A `default` may be a function of `{ cwd, agentDir }`; a
  `transform` runs on the merged value, default included. `load` never throws:
  a missing file is silent; an unreadable, unparseable or non-object file warns
  `[pi-<name>] Ignoring settings at <path>: <reason>`; invalid and unknown fields,
  and invalid list or record members, are dropped with one warning per file that
  names each. Every warning is
  terminal-safe. Dropped values fall back to the lower layer, then the default.
  `save` keeps unknown keys, drops invalid fields and refuses a malformed file.

  Every extension's settings use a definition. `defineSettings` is built on
  `readSettingsFile`, `writeSettingsFile` and `patchSettingsFile`, which stay
  exported: missing files are absent, and other errors throw unless the caller
  supplies an error callback.

- `src/models.ts`: `findExactModel`, `compareNewestFirst`, `resolveModel`, and
  structural model/registry types. Exact matching is case-insensitive; the full
  resolver additionally supports fuzzy matching and `[provider/]family@latest`.
  Available models take precedence over the full catalog. Model identity and
  extra fields are preserved.

Extensions own model preference and inheritance. TLDR keeps exact configured
model matching with Haiku/Luna auto selection. Subagents keeps invocation
fallback policy and compatibility exports.

Run `npm run check` and `npm run test:workspace -- pi-foundations`.

## Plain-data helpers

These modules have no Pi or pi-ui dependencies. Import them through
`#foundations/*`; terminal sanitizing remains in pi-ui and at consumer boundaries.

- `src/guards.ts`: `isRecord` accepts non-null objects, including objects with a
  custom or null prototype, and rejects arrays.
- `src/errors.ts`: `errorText` preserves `Error.message` or falls back to `String`.
- `src/cmux.ts`: `CmuxNotifications`, native notifications through cmux's public
  CLI, one instance per extension session. `open(message)` shows a notification
  for as long as something is on screen and returns the function that dismisses
  exactly that one; `send(message)` shows one that stays and resolves whether
  cmux took it; `shutdown()` dismisses the open ones and drains pending CLI
  calls within a bound. Outside cmux, with `CMUX_PI_HOOKS_DISABLED=1`, or when
  the CLI is missing, fails or hangs, every call is a silent no-op. Callers
  sanitize and bound the text.
- `src/format.ts`: `oneLine(text, max?)` collapses whitespace and optionally caps
  the result including the ellipsis (zero returns empty text). `plural(n, one,
  many?)` returns the word only. `formatBytes(bytes, style?)` defaults to stash's
  adaptive display units; `"log"` retains pi-job's rounded KB/MB and `bytes`.
  `formatDuration(ms, style?)` defaults to compact rounded job durations;
  `"seconds"` retains the agent display's decimal seconds. Timestamp and running
  suffix policies stay in the agent's `formatAgentDuration` wrapper.
