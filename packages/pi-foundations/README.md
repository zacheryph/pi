# pi-foundations

Shared settings and model lookup primitives for this source bundle. This is a
private library, not a Pi extension. Its settings module imports `getAgentDir`
from Pi and `sanitizeLine` from `pi-ui`'s dependency-free `src/text.ts`; nothing
else beyond Node. Import its source by relative path, just like
`pi-session-tree`; Git installs do not link npm workspaces.

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

Run `npm run check -w pi-foundations` and `npm test -w pi-foundations`.
